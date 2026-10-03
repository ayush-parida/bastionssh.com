import type {
  KubeDiagnosis,
  KubeGraph,
  KubeGraphEdge,
  KubeGraphHealth,
  KubeGraphNode,
  KubeGraphRelation,
  KubePodTile,
  KubePodTileStatus,
  KubeResource,
  KubeWorkloadHealth,
  KubeWorkloadKind,
} from '@smt/shared';
import { KUBE_GRAPH_MAX_GROUP_PODS } from '@smt/shared';
import type { KubeObject } from './client.js';
import { type DiagnosisInput, ownerResolver, podReady, refKey, refOf, selectorMatches, workloadHealth } from './health.js';
import { mapSelectorString, toPodTile } from './views.js';

/**
 * The app topology graph (spec §5.2), built from cached objects of one
 * namespace (or every visible one):
 *
 *   Ingress → Service → Deployment / StatefulSet / DaemonSet / CronJob → Job → Pods
 *
 * with side links to ConfigMaps, Secrets (by name — values never reach the
 * cache), PersistentVolumeClaims → PersistentVolumes and
 * HorizontalPodAutoscalers. Every edge comes from a real relationship:
 *
 * - Ingress rules and default backend → Service names;
 * - Service selectors → pod labels, drawn to the workload that owns the pods
 *   (and to workloads whose pod template matches, so a Deployment scaled to
 *   zero still shows what it would serve);
 * - ownerReferences: Pod → ReplicaSet → Deployment (the ReplicaSet is folded
 *   into the Deployment), Pod → Job → CronJob;
 * - volumes, `envFrom` and `env.valueFrom` → ConfigMap / Secret / claim, from
 *   the pod template and from the running pods (StatefulSet claims);
 * - a claim's `volumeName` → PersistentVolume; an HPA's `scaleTargetRef`.
 *
 * A workload's pods are one replica ring node (ready/desired, counts per
 * colour, the pods themselves for expanding), so a namespace with hundreds
 * of pods stays readable. Edges that lead nowhere — an Ingress to a Service
 * that does not exist, a Service no ready pod answers, a reference to a
 * missing ConfigMap — are `broken`, with the reason in words.
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): Json[] => (Array.isArray(value) ? (value.filter((v) => typeof v === 'object' && v) as Json[]) : []);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** What the graph view follows and reads. */
export const GRAPH_RESOURCES: KubeResource[] = [
  'ingresses',
  'services',
  'deployments',
  'statefulsets',
  'daemonsets',
  'cronjobs',
  'jobs',
  'replicasets',
  'pods',
  'horizontalpodautoscalers',
  'persistentvolumeclaims',
  'persistentvolumes',
  'configmaps',
  'secrets',
  'events',
  'nodes',
  'storageclasses',
];

/** What the diagnoses read (the attention list, an object's insight). */
export const DIAGNOSIS_RESOURCES: KubeResource[] = [
  'pods',
  'nodes',
  'events',
  'services',
  'persistentvolumeclaims',
  'storageclasses',
  'deployments',
  'replicasets',
  'jobs',
];

/** Lists by resource; null where the credential may not list it. */
export type ObjectsByResource = Partial<Record<KubeResource, KubeObject[] | null>>;

/**
 * Diagnosis input from lists read for a view. `podsCoverCluster`: the pods
 * are every pod of the cluster (no namespace picked, no allowlist), so the
 * nodes' free capacity can be counted.
 */
export function diagnosisInput(objects: ObjectsByResource, podsCoverCluster = true): DiagnosisInput {
  return {
    pods: objects.pods ?? [],
    podsListed: objects.pods !== null,
    podsCoverCluster,
    nodes: objects.nodes ?? null,
    events: objects.events ?? [],
    services: objects.services ?? [],
    claims: objects.persistentvolumeclaims ?? [],
    storageClasses: objects.storageclasses ?? null,
    deployments: objects.deployments ?? [],
    replicaSets: objects.replicasets ?? [],
    jobs: objects.jobs ?? [],
  };
}

export const WORKLOADS: { resource: KubeResource; kind: KubeWorkloadKind }[] = [
  { resource: 'deployments', kind: 'Deployment' },
  { resource: 'statefulsets', kind: 'StatefulSet' },
  { resource: 'daemonsets', kind: 'DaemonSet' },
  { resource: 'cronjobs', kind: 'CronJob' },
  { resource: 'jobs', kind: 'Job' },
];

/** More bare pods than this in a namespace go into one ring. */
const MAX_LOOSE_PODS = 20;

const WORKLOAD_COLOUR: Record<KubeWorkloadHealth, KubeGraphHealth> = {
  healthy: 'healthy',
  progressing: 'progressing',
  degraded: 'warning',
  failed: 'failing',
  suspended: 'idle',
  completed: 'idle',
  idle: 'idle',
};

const TILE_ORDER: Record<KubePodTileStatus, number> = { failing: 0, pending: 1, terminating: 2, running: 3, completed: 4 };

const nodeId = (kind: string, namespace: string | null | undefined, name: string) => `${kind}/${namespace ?? ''}/${name}`;

interface Ref {
  kind: 'ConfigMap' | 'Secret' | 'PersistentVolumeClaim';
  name: string;
  optional: boolean;
  relation: KubeGraphRelation;
}

/** The ConfigMaps, Secrets and claims a pod spec reads, through volumes and env. */
export function podSpecRefs(spec: Json): Ref[] {
  const out: Ref[] = [];
  for (const v of arr(spec.volumes)) {
    // The token volume every pod gets (kube-root-ca.crt): noise on every workload
    if ((str(v.name) ?? '').startsWith('kube-api-access-')) continue;
    const claim = str(obj(v.persistentVolumeClaim).claimName);
    if (claim) out.push({ kind: 'PersistentVolumeClaim', name: claim, optional: false, relation: 'mounts' });
    const cm = obj(v.configMap);
    if (str(cm.name)) out.push({ kind: 'ConfigMap', name: str(cm.name)!, optional: cm.optional === true, relation: 'mounts' });
    const secret = obj(v.secret);
    if (str(secret.secretName)) out.push({ kind: 'Secret', name: str(secret.secretName)!, optional: secret.optional === true, relation: 'mounts' });
    for (const source of arr(obj(v.projected).sources)) {
      const pcm = obj(source.configMap);
      if (str(pcm.name)) out.push({ kind: 'ConfigMap', name: str(pcm.name)!, optional: pcm.optional === true, relation: 'mounts' });
      const ps = obj(source.secret);
      if (str(ps.name)) out.push({ kind: 'Secret', name: str(ps.name)!, optional: ps.optional === true, relation: 'mounts' });
    }
  }
  for (const c of [...arr(spec.initContainers), ...arr(spec.containers)]) {
    for (const from of arr(c.envFrom)) {
      const cm = obj(from.configMapRef);
      if (str(cm.name)) out.push({ kind: 'ConfigMap', name: str(cm.name)!, optional: cm.optional === true, relation: 'env' });
      const secret = obj(from.secretRef);
      if (str(secret.name)) out.push({ kind: 'Secret', name: str(secret.name)!, optional: secret.optional === true, relation: 'env' });
    }
    for (const env of arr(c.env)) {
      const valueFrom = obj(env.valueFrom);
      const cm = obj(valueFrom.configMapKeyRef);
      if (str(cm.name)) out.push({ kind: 'ConfigMap', name: str(cm.name)!, optional: cm.optional === true, relation: 'env' });
      const secret = obj(valueFrom.secretKeyRef);
      if (str(secret.name)) out.push({ kind: 'Secret', name: str(secret.name)!, optional: secret.optional === true, relation: 'env' });
    }
  }
  return out;
}

/** A workload's pod template spec and labels (a CronJob's through its job template). */
export function template(kind: string, w: KubeObject): { spec: Json; labels: Record<string, string> } {
  const spec = obj(w.spec);
  const tpl = kind === 'CronJob' ? obj(obj(obj(spec.jobTemplate).spec).template) : obj(spec.template);
  return { spec: obj(tpl.spec), labels: obj(obj(tpl.metadata).labels) as Record<string, string> };
}

export interface GraphInput {
  namespace: string | null;
  objects: ObjectsByResource;
  diagnoses: KubeDiagnosis[];
  warnings?: string[];
}

export function buildGraph(input: GraphInput): KubeGraph {
  const o = input.objects;
  const list = (r: KubeResource) => o[r] ?? [];
  const nodes = new Map<string, KubeGraphNode>();
  const edges = new Map<string, KubeGraphEdge>();

  // Problems per object: a pod's count towards the workload behind it
  const problems = new Map<string, number>();
  for (const d of input.diagnoses) {
    const key = d.owner && d.subject.kind === 'Pod' ? refKey(d.owner) : refKey(d.subject);
    problems.set(key, (problems.get(key) ?? 0) + 1);
  }
  const problemsOf = (kind: string, ns: string | null | undefined, name: string) => problems.get(nodeId(kind, ns, name)) ?? 0;

  const addNode = (node: Omit<KubeGraphNode, 'problems'> & { problems?: number }) => {
    const full: KubeGraphNode = { problems: problemsOf(node.kind, node.namespace, node.name), ...node };
    // A known problem never shows green
    if (full.problems > 0 && (full.health === 'healthy' || full.health === 'idle' || full.health === 'progressing')) full.health = 'warning';
    nodes.set(full.id, full);
    return full;
  };
  const addEdge = (source: string, target: string, relation: KubeGraphRelation, broken: boolean, explanation: string) => {
    const id = `${relation}:${source}->${target}`;
    const existing = edges.get(id);
    // The same link seen twice (template and pods): broken wins, so a problem is never hidden
    if (existing && (existing.broken || !broken)) return;
    edges.set(id, { id, source, target, relation, broken, explanation });
  };
  /** A node for something referenced that does not exist. */
  const addMissing = (kind: string, ns: string | null, name: string, summary: string) => {
    const id = `missing:${nodeId(kind, ns, name)}`;
    if (!nodes.has(id)) nodes.set(id, { id, kind, name, namespace: ns, ref: null, health: 'missing', summary, problems: 0 });
    return id;
  };

  // Workloads
  const workloadIds = new Map<string, KubeObject>();
  for (const { resource, kind } of WORKLOADS) {
    for (const w of list(resource)) {
      const ns = w.metadata.namespace ?? null;
      const h = workloadHealth(kind, w);
      const id = nodeId(kind, ns, w.metadata.name);
      workloadIds.set(id, w);
      addNode({ id, kind, name: w.metadata.name, namespace: ns, ref: refOf(kind, ns, w.metadata.name), health: WORKLOAD_COLOUR[h.health], summary: h.summary });
    }
  }
  // A CronJob's Jobs hang off it
  for (const job of list('jobs')) {
    const owner = (job.metadata.ownerReferences ?? []).find((r) => r.kind === 'CronJob');
    const ns = job.metadata.namespace ?? null;
    if (owner && nodes.has(nodeId('CronJob', ns, owner.name))) {
      addEdge(nodeId('CronJob', ns, owner.name), nodeId('Job', ns, job.metadata.name), 'owns', false, 'Started this Job on its schedule');
    }
  }
  // ReplicaSets nothing (readable) owns are workloads of their own
  for (const rs of list('replicasets')) {
    const ns = rs.metadata.namespace ?? null;
    const owner = (rs.metadata.ownerReferences ?? []).find((r) => r.controller) ?? rs.metadata.ownerReferences?.[0];
    if (owner?.kind === 'Deployment') continue;
    const desired = num(obj(rs.spec).replicas, 1);
    const ready = num(obj(rs.status).readyReplicas);
    const id = nodeId('ReplicaSet', ns, rs.metadata.name);
    workloadIds.set(id, rs);
    addNode({
      id,
      kind: 'ReplicaSet',
      name: rs.metadata.name,
      namespace: ns,
      ref: refOf('ReplicaSet', ns, rs.metadata.name),
      health: desired === 0 ? 'idle' : ready >= desired ? 'healthy' : ready === 0 ? 'failing' : 'warning',
      summary: desired === 0 ? 'Scaled to zero' : `${ready} of ${desired} ready`,
    });
  }

  // Pods: one ring per owner; bare pods alone (or in one ring when there are many)
  const ringOwner = ownerResolver(list('replicasets'), []);
  const rings = new Map<string, { owner: string | null; label: string; namespace: string | null; desired: number | null; pods: KubeObject[] }>();
  const loose = new Map<string, KubeObject[]>();
  /** Where a pod is drawn: its ring, or its own node. */
  const podHome = new Map<KubeObject, string>();
  for (const pod of list('pods')) {
    const ns = pod.metadata.namespace ?? null;
    const owner = ringOwner(pod);
    if (!owner) {
      loose.set(ns ?? '', [...(loose.get(ns ?? '') ?? []), pod]);
      continue;
    }
    const ownerNode = nodeId(owner.kind, ns, owner.name);
    const id = `pods:${ownerNode}`;
    let ring = rings.get(id);
    if (!ring) {
      const w = workloadIds.get(ownerNode);
      const desired = w ? (workloadHealth(owner.kind as KubeWorkloadKind, w).desired ?? null) : null;
      ring = { owner: nodes.has(ownerNode) ? ownerNode : null, label: nodes.has(ownerNode) ? owner.name : `${owner.kind} ${owner.name}`, namespace: ns, desired, pods: [] };
      if (owner.kind === 'ReplicaSet' && w) ring.desired = num(obj(w.spec).replicas, 1);
      rings.set(id, ring);
    }
    ring.pods.push(pod);
    podHome.set(pod, id);
  }
  for (const [ns, pods] of loose) {
    if (pods.length > MAX_LOOSE_PODS) {
      const id = `pods:standalone/${ns}`;
      rings.set(id, { owner: null, label: 'Standalone pods', namespace: ns || null, desired: null, pods });
      for (const pod of pods) podHome.set(pod, id);
      continue;
    }
    for (const pod of pods) {
      const tile = toPodTile(pod);
      const id = nodeId('Pod', ns || null, pod.metadata.name);
      podHome.set(pod, id);
      addNode({
        id,
        kind: 'Pod',
        name: pod.metadata.name,
        namespace: ns || null,
        ref: refOf('Pod', ns, pod.metadata.name),
        health: tile.status === 'failing' ? 'failing' : tile.status === 'pending' ? 'warning' : tile.status === 'running' ? 'healthy' : 'idle',
        summary: tile.reason ?? tile.phase,
      });
    }
  }
  for (const [id, ring] of rings) {
    const tiles: KubePodTile[] = ring.pods.map(toPodTile).sort((a, b) => TILE_ORDER[a.status] - TILE_ORDER[b.status] || a.name.localeCompare(b.name));
    const counts: Record<KubePodTileStatus, number> = { running: 0, pending: 0, failing: 0, completed: 0, terminating: 0 };
    for (const t of tiles) counts[t.status] += 1;
    const ready = ring.pods.filter(podReady).length;
    const health: KubeGraphHealth = counts.failing
      ? 'failing'
      : counts.pending
        ? 'warning'
        : counts.running
          ? ready < counts.running
            ? 'warning'
            : 'healthy'
          : counts.terminating
            ? 'progressing'
            : 'idle';
    nodes.set(id, {
      id,
      kind: 'Pods',
      name: ring.label,
      namespace: ring.namespace,
      ref: null,
      health,
      summary: `${ready} of ${ring.desired ?? ring.pods.length} ready`,
      problems: 0,
      pods: { ready, total: ring.pods.length, desired: ring.desired, counts, pods: tiles.slice(0, KUBE_GRAPH_MAX_GROUP_PODS) },
    });
    if (ring.owner) addEdge(ring.owner, id, 'owns', false, `Runs ${ring.pods.length} pod${ring.pods.length === 1 ? '' : 's'}`);
  }

  // Config and storage, from templates and from the pods themselves
  const configMaps = o.configmaps ?? null;
  const secrets = o.secrets ?? null;
  const claims = list('persistentvolumeclaims');
  const findIn = (items: KubeObject[] | null, ns: string | null, name: string) =>
    items === null ? undefined : (items.find((i) => (i.metadata.namespace ?? null) === ns && i.metadata.name === name) ?? null);
  const linkRefs = (source: string, ns: string | null, refs: Ref[]) => {
    for (const ref of refs) {
      const items = ref.kind === 'ConfigMap' ? configMaps : ref.kind === 'Secret' ? secrets : claims;
      const found = findIn(items, ns, ref.name);
      const verb = ref.relation === 'env' ? 'read settings from' : 'mount';
      if (found === null) {
        if (ref.optional) continue;
        const target = addMissing(ref.kind, ns, ref.name, 'Does not exist');
        addEdge(source, target, ref.relation, true, `Its pods ${verb} ${ref.kind} \`${ref.name}\`, which does not exist — they cannot start.`);
        continue;
      }
      const target = nodeId(ref.kind, ns, ref.name);
      if (!nodes.has(target)) {
        addNode({
          id: target,
          kind: ref.kind,
          name: ref.name,
          namespace: ns,
          ref: refOf(ref.kind, ns, ref.name),
          health: found === undefined ? 'idle' : 'healthy',
          summary:
            found === undefined
              ? 'Not listable with this credential'
              : ref.kind === 'Secret'
                ? `${str(found.type) ?? 'Opaque'} · values never shown`
                : `${Object.keys({ ...obj(found.data), ...obj(found.binaryData) }).length} keys`,
        });
      }
      addEdge(source, target, ref.relation, false, `Its pods ${verb} ${ref.kind} \`${ref.name}\``);
    }
  };
  for (const [id, w] of workloadIds) {
    if (!nodes.has(id)) continue;
    linkRefs(id, w.metadata.namespace ?? null, podSpecRefs(template(nodes.get(id)!.kind, w).spec));
  }
  for (const [pod, home] of podHome) {
    const ring = rings.get(home);
    linkRefs(ring?.owner ?? home, pod.metadata.namespace ?? null, podSpecRefs(obj(pod.spec)));
  }

  // Every claim (a pending one is often the problem), bound to its volume
  const volumes = o.persistentvolumes ?? null;
  // A claim that will get no storage is as red as its diagnosis; one still being provisioned stays amber
  const noStorage = new Set(input.diagnoses.filter((d) => d.id === 'pvc-pending' && d.severity === 'critical').map((d) => refKey(d.subject)));
  for (const claim of claims) {
    const ns = claim.metadata.namespace ?? null;
    const id = nodeId('PersistentVolumeClaim', ns, claim.metadata.name);
    const phase = str(obj(claim.status).phase) ?? 'Pending';
    const size = str(obj(obj(claim.status).capacity).storage) ?? str(obj(obj(obj(claim.spec).resources).requests).storage);
    addNode({
      id,
      kind: 'PersistentVolumeClaim',
      name: claim.metadata.name,
      namespace: ns,
      ref: refOf('PersistentVolumeClaim', ns, claim.metadata.name),
      health: phase === 'Bound' ? 'healthy' : phase === 'Lost' || noStorage.has(id) ? 'failing' : 'warning',
      summary: `${phase}${size ? ` · ${size}` : ''}`,
    });
    const volumeName = str(obj(claim.spec).volumeName);
    if (!volumeName || volumes === null) continue;
    const pv = volumes.find((v) => v.metadata.name === volumeName);
    if (!pv) {
      const target = addMissing('PersistentVolume', null, volumeName, 'Does not exist');
      addEdge(id, target, 'bound', true, `Bound to PersistentVolume \`${volumeName}\`, which no longer exists.`);
      continue;
    }
    const pvPhase = str(obj(pv.status).phase) ?? 'Unknown';
    const pvId = nodeId('PersistentVolume', null, volumeName);
    addNode({
      id: pvId,
      kind: 'PersistentVolume',
      name: volumeName,
      namespace: null,
      ref: refOf('PersistentVolume', null, volumeName),
      health: pvPhase === 'Bound' || pvPhase === 'Available' ? 'healthy' : pvPhase === 'Failed' ? 'failing' : 'warning',
      summary: `${pvPhase}${str(obj(obj(pv.spec).capacity).storage) ? ` · ${str(obj(obj(pv.spec).capacity).storage)}` : ''}${str(obj(pv.spec).storageClassName) ? ` · ${str(obj(pv.spec).storageClassName)}` : ''}`,
    });
    addEdge(id, pvId, 'bound', false, `Stored on PersistentVolume \`${volumeName}\``);
  }

  // Services → the workloads whose pods they select
  const pods = list('pods');
  const podsListed = o.pods !== null;
  const serviceBroken = new Map<string, boolean>();
  for (const svc of list('services')) {
    const ns = svc.metadata.namespace ?? null;
    const spec = obj(svc.spec);
    const id = nodeId('Service', ns, svc.metadata.name);
    const type = str(spec.type) ?? 'ClusterIP';
    const ports = arr(spec.ports).map((p) => `${num(p.port)}${p.targetPort !== undefined ? `→${String(p.targetPort)}` : ''}`);
    const selector = mapSelectorString(spec.selector);
    const summary = type === 'ExternalName' ? `ExternalName → ${str(spec.externalName) ?? '?'}` : `${type}${ports.length ? ` · ${ports.join(', ')}` : ''}`;
    if (!selector || type === 'ExternalName') {
      addNode({ id, kind: 'Service', name: svc.metadata.name, namespace: ns, ref: refOf('Service', ns, svc.metadata.name), health: 'healthy', summary });
      serviceBroken.set(id, false);
      continue;
    }
    const matched = pods.filter((p) => (p.metadata.namespace ?? null) === ns && selectorMatches(spec.selector, p.metadata.labels));
    const targets = new Set<string>();
    for (const p of matched) {
      const home = podHome.get(p);
      if (!home) continue;
      targets.add(rings.get(home)?.owner ?? home);
    }
    for (const [wid, w] of workloadIds) {
      if ((w.metadata.namespace ?? null) !== ns || !nodes.has(wid)) continue;
      if (selectorMatches(spec.selector, template(nodes.get(wid)!.kind, w).labels)) targets.add(wid);
    }
    if (!podsListed) {
      // Which pods answer is unknown: link what the templates say, call nothing broken
      serviceBroken.set(id, false);
      addNode({ id, kind: 'Service', name: svc.metadata.name, namespace: ns, ref: refOf('Service', ns, svc.metadata.name), health: 'idle', summary });
      for (const target of targets) addEdge(id, target, 'selects', false, `Sends traffic to the pods labelled \`${selector}\``);
      continue;
    }
    const anyReady = matched.some(podReady);
    serviceBroken.set(id, !anyReady);
    addNode({
      id,
      kind: 'Service',
      name: svc.metadata.name,
      namespace: ns,
      ref: refOf('Service', ns, svc.metadata.name),
      health: anyReady ? 'healthy' : 'failing',
      summary,
    });
    if (!targets.size) {
      const target = addMissing('Pods', ns, `${svc.metadata.name}-selector`, 'Traffic goes nowhere');
      nodes.get(target)!.name = `No pods match ${selector}`;
      addEdge(id, target, 'selects', true, `This Service selects \`${selector}\`, but no pod has these labels — traffic goes nowhere.`);
      continue;
    }
    for (const target of targets) {
      addEdge(
        id,
        target,
        'selects',
        !anyReady,
        anyReady
          ? `Sends traffic to the ready pods labelled \`${selector}\``
          : `Selects \`${selector}\`, but none of those pods is ready — traffic goes nowhere.`,
      );
    }
  }

  // Ingresses → Services
  for (const ing of list('ingresses')) {
    const ns = ing.metadata.namespace ?? null;
    const spec = obj(ing.spec);
    const id = nodeId('Ingress', ns, ing.metadata.name);
    const routes: { service: string; port: string | null; where: string }[] = [];
    const backend = (b: Json, where: string) => {
      const svc = obj(b.service);
      if (!str(svc.name)) return;
      const port = obj(svc.port);
      routes.push({ service: str(svc.name)!, port: str(port.name) ?? (port.number !== undefined ? String(port.number) : null), where });
    };
    backend(obj(spec.defaultBackend), 'everything else');
    for (const rule of arr(spec.rules)) {
      for (const path of arr(obj(rule.http).paths)) backend(obj(path.backend), `${str(rule.host) ?? '*'}${str(path.path) ?? '/'}`);
    }
    let missing = false;
    let degraded = false;
    const links: [string, boolean, string][] = [];
    for (const r of routes) {
      const target = nodeId('Service', ns, r.service);
      if (!nodes.has(target) && o.services === null) {
        // Not listable: never called missing
        addNode({ id: target, kind: 'Service', name: r.service, namespace: ns, ref: refOf('Service', ns, r.service), health: 'idle', summary: 'Not listable with this credential' });
      }
      if (!nodes.has(target)) {
        missing = true;
        const m = addMissing('Service', ns, r.service, 'Does not exist');
        links.push([m, true, `This Ingress sends ${r.where} to Service \`${r.service}\`, which does not exist.`]);
        continue;
      }
      if (serviceBroken.get(target)) degraded = true;
      links.push([target, false, `Routes ${r.where} to Service \`${r.service}\`${r.port ? ` port ${r.port}` : ''}`]);
    }
    const hosts = [...new Set(arr(spec.rules).map((r) => str(r.host) ?? '*'))];
    addNode({
      id,
      kind: 'Ingress',
      name: ing.metadata.name,
      namespace: ns,
      ref: refOf('Ingress', ns, ing.metadata.name),
      health: missing ? 'failing' : degraded ? 'warning' : 'healthy',
      summary: hosts.length ? hosts.join(', ') : 'all hosts',
    });
    for (const [target, broken, why] of links) addEdge(id, target, 'routes', broken, why);
  }

  // Autoscalers → what they scale
  for (const hpa of list('horizontalpodautoscalers')) {
    const ns = hpa.metadata.namespace ?? null;
    const spec = obj(hpa.spec);
    const status = obj(hpa.status);
    const target = obj(spec.scaleTargetRef);
    const id = nodeId('HorizontalPodAutoscaler', ns, hpa.metadata.name);
    const active = arr(status.conditions).find((c) => c.type === 'ScalingActive');
    addNode({
      id,
      kind: 'HorizontalPodAutoscaler',
      name: hpa.metadata.name,
      namespace: ns,
      ref: refOf('HorizontalPodAutoscaler', ns, hpa.metadata.name),
      health: active && active.status === 'False' ? 'warning' : 'healthy',
      summary: `${num(status.currentReplicas)} replicas (min ${num(spec.minReplicas, 1)}, max ${num(spec.maxReplicas)})`,
    });
    const kind = str(target.kind);
    const name = str(target.name);
    if (!kind || !name) continue;
    const wid = nodeId(kind, ns, name);
    const scales = `Scales ${kind} \`${name}\` between ${num(spec.minReplicas, 1)} and ${num(spec.maxReplicas)} replicas`;
    if (nodes.has(wid)) {
      addEdge(id, wid, 'scales', false, scales);
      continue;
    }
    // Only a kind this graph lists, and could list, is known to be missing; anything else (a custom resource) is just not drawn
    const workload = WORKLOADS.find((w) => w.kind === kind) ?? (kind === 'ReplicaSet' ? { resource: 'replicasets' as const, kind } : null);
    if (!workload) continue;
    if (o[workload.resource] === null || o[workload.resource] === undefined) {
      addNode({ id: wid, kind, name, namespace: ns, ref: refOf(kind, ns, name), health: 'idle', summary: 'Not listable with this credential' });
      addEdge(id, wid, 'scales', false, scales);
      continue;
    }
    // Exists but folded away (a Deployment's ReplicaSet)
    if (o[workload.resource]!.some((w) => w.metadata.name === name && (w.metadata.namespace ?? null) === ns)) continue;
    addEdge(id, addMissing(kind, ns, name, 'Does not exist'), 'scales', true, `Scales ${kind} \`${name}\`, which does not exist.`);
  }

  return {
    namespace: input.namespace,
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    warnings: input.warnings ?? [],
    generatedAt: new Date().toISOString(),
  };
}
