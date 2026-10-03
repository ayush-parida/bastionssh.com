import type {
  KubeFact,
  KubeNamespace,
  KubeNodeCard,
  KubeObjectRef,
  KubeOverview,
  KubePodTile,
  KubeResource,
  KubeResourceAmounts,
  KubeWorkload,
  KubeWorkloadKind,
} from '@smt/shared';
import { KUBE_RESOURCES, kubeResourceOfKind } from '@smt/shared';
import type { KubeObject } from './client.js';
import { isUnscheduled, podHealth, workloadHealth } from './health.js';
import { bytes, cpuMillis, parseQuantity } from './quantity.js';

/**
 * Raw API objects → what the views show (shared types in @smt/shared
 * kube.ts). Pure functions over already-redacted, cached objects: the
 * routes gather the objects, these shape them.
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): Json[] => (Array.isArray(value) ? (value.filter((v) => typeof v === 'object' && v) as Json[]) : []);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

// ── Pods and nodes ───────────────────────────────────────────

function controllerOf(o: KubeObject): { kind: string; name: string } | null {
  const refs = o.metadata.ownerReferences ?? [];
  const ref = refs.find((r) => r.controller) ?? refs[0];
  return ref ? { kind: ref.kind, name: ref.name } : null;
}

export function toPodTile(pod: KubeObject): KubePodTile {
  const h = podHealth(pod);
  return {
    namespace: pod.metadata.namespace ?? '',
    name: pod.metadata.name,
    status: h.status,
    phase: str(obj(pod.status).phase) ?? 'Unknown',
    reason: h.reason,
    restarts: h.restarts,
    readyContainers: h.readyContainers,
    totalContainers: h.totalContainers,
    nodeName: str(obj(pod.spec).nodeName),
    owner: controllerOf(pod),
    message: h.message,
    createdAt: pod.metadata.creationTimestamp ?? null,
  };
}

/** What a pod asks the scheduler for: its containers, or its largest init container if bigger, plus overhead. */
export function podRequests(pod: KubeObject): KubeResourceAmounts {
  const spec = obj(pod.spec);
  const sum = (containers: Json[]) =>
    containers.reduce(
      (acc, c) => {
        const requests = obj(obj(c.resources).requests);
        return { cpuMillis: acc.cpuMillis + cpuMillis(requests.cpu), memoryBytes: acc.memoryBytes + bytes(requests.memory) };
      },
      { cpuMillis: 0, memoryBytes: 0 } as KubeResourceAmounts,
    );
  const main = sum(arr(spec.containers));
  const init = arr(spec.initContainers).map((c) => sum([c]));
  const overhead = obj(spec.overhead);
  return {
    cpuMillis: Math.max(main.cpuMillis, ...init.map((i) => i.cpuMillis)) + cpuMillis(overhead.cpu),
    memoryBytes: Math.max(main.memoryBytes, ...init.map((i) => i.memoryBytes)) + bytes(overhead.memory),
  };
}

/** Node roles from its labels; `worker` when it has none. */
export function nodeRoles(node: KubeObject): string[] {
  const labels = node.metadata.labels ?? {};
  const roles = Object.keys(labels)
    .filter((k) => k.startsWith('node-role.kubernetes.io/'))
    .map((k) => k.slice('node-role.kubernetes.io/'.length))
    .filter(Boolean);
  if (!roles.length && labels['kubernetes.io/role']) roles.push(labels['kubernetes.io/role']);
  // k3s marks its servers "master" and "control-plane": one badge is enough
  const unique = [...new Set(roles.map((r) => (r === 'master' ? 'control-plane' : r)))];
  return unique.length ? unique.sort() : ['worker'];
}

const PRESSURES = ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable'];

function emptyCard(name: string): KubeNodeCard {
  return {
    name,
    roles: [],
    ready: true,
    unschedulable: false,
    pressures: [],
    kubeletVersion: null,
    osImage: null,
    architecture: null,
    allocatable: { cpuMillis: 0, memoryBytes: 0, pods: 0 },
    requested: { cpuMillis: 0, memoryBytes: 0 },
    usage: null,
    pods: [],
  };
}

export function toNodeCard(node: KubeObject, usage: KubeResourceAmounts | null): KubeNodeCard {
  const status = obj(node.status);
  const conditions = arr(status.conditions);
  const info = obj(status.nodeInfo);
  const allocatable = obj(status.allocatable);
  return {
    ...emptyCard(node.metadata.name),
    roles: nodeRoles(node),
    ready: conditions.find((c) => c.type === 'Ready')?.status === 'True',
    unschedulable: obj(node.spec).unschedulable === true,
    pressures: conditions.filter((c) => PRESSURES.includes(String(c.type)) && c.status === 'True').map((c) => String(c.type)),
    kubeletVersion: str(info.kubeletVersion),
    osImage: str(info.osImage),
    architecture: str(info.architecture),
    allocatable: {
      cpuMillis: cpuMillis(allocatable.cpu),
      memoryBytes: bytes(allocatable.memory),
      pods: Math.round(parseQuantity(allocatable.pods)),
    },
    usage,
  };
}

const TILE_ORDER = { failing: 0, pending: 1, terminating: 2, running: 3, completed: 4 } as const;

function byTile(a: KubePodTile, b: KubePodTile) {
  return TILE_ORDER[a.status] - TILE_ORDER[b.status] || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name);
}

export interface OverviewInput {
  clusterId: string;
  serverVersion: string | null;
  /** Null when nodes could not be listed with this credential. */
  nodes: KubeObject[] | null;
  pods: KubeObject[];
  namespaces: string[];
  nodeUsage: Map<string, KubeResourceAmounts> | null;
  warnings: string[];
}

/** The cluster map (spec §5.1): node cards with their pods, and the pods no node has taken. */
export function buildOverview(input: OverviewInput): KubeOverview {
  const cards = new Map<string, KubeNodeCard>();
  for (const node of input.nodes ?? []) cards.set(node.metadata.name, toNodeCard(node, input.nodeUsage?.get(node.metadata.name) ?? null));
  const unscheduled: KubePodTile[] = [];
  for (const pod of input.pods) {
    const tile = toPodTile(pod);
    if (isUnscheduled(pod) || !tile.nodeName) {
      if (tile.status !== 'completed') unscheduled.push(tile);
      continue;
    }
    let card = cards.get(tile.nodeName);
    if (!card) {
      // Nodes not listable (or the node is gone): still show where pods run
      card = emptyCard(tile.nodeName);
      cards.set(tile.nodeName, card);
    }
    card.pods.push(tile);
    if (tile.status !== 'completed' && tile.phase !== 'Failed') {
      const r = podRequests(pod);
      card.requested.cpuMillis += r.cpuMillis;
      card.requested.memoryBytes += r.memoryBytes;
    }
  }
  const nodes = [...cards.values()];
  for (const card of nodes) card.pods.sort(byTile);
  nodes.sort((a, b) => {
    const cp = Number(b.roles.includes('control-plane')) - Number(a.roles.includes('control-plane'));
    return cp || a.name.localeCompare(b.name);
  });
  return {
    clusterId: input.clusterId,
    serverVersion: input.serverVersion,
    metricsAvailable: input.nodeUsage !== null,
    namespaces: input.namespaces,
    nodes,
    unscheduled: unscheduled.sort(byTile),
    warnings: input.warnings,
    generatedAt: new Date().toISOString(),
  };
}

export function toNamespace(ns: KubeObject): KubeNamespace {
  return {
    name: ns.metadata.name,
    phase: str(obj(ns.status).phase) ?? 'Active',
    createdAt: ns.metadata.creationTimestamp ?? null,
    labels: ns.metadata.labels ?? {},
  };
}

// ── Workloads ────────────────────────────────────────────────

/** Container images of a pod template (or a CronJob's job template). */
export function templateImages(kind: KubeWorkloadKind, w: KubeObject): string[] {
  const spec = obj(w.spec);
  const template = kind === 'CronJob' ? obj(obj(obj(spec.jobTemplate).spec).template) : obj(spec.template);
  return [...new Set(arr(obj(template.spec).containers).map((c) => str(c.image)).filter((i): i is string => !!i))];
}

export function toWorkload(kind: KubeWorkloadKind, w: KubeObject): KubeWorkload {
  const h = workloadHealth(kind, w);
  return {
    kind,
    namespace: w.metadata.namespace ?? '',
    name: w.metadata.name,
    health: h.health,
    summary: h.summary,
    desired: h.desired,
    ready: h.ready,
    images: templateImages(kind, w),
    createdAt: w.metadata.creationTimestamp ?? null,
    lastRunAt: h.lastRunAt ?? null,
  };
}

// ── Object detail ────────────────────────────────────────────

/** `matchLabels` as a label selector string; null when there is none (an empty selector matches nothing here). */
export function selectorString(selector: unknown): string | null {
  const labels = obj(obj(selector).matchLabels);
  const parts = Object.entries(labels)
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => `${k}=${v as string}`);
  const exprs = arr(obj(selector).matchExpressions);
  for (const e of exprs) {
    const key = str(e.key);
    const values = Array.isArray(e.values) ? (e.values as unknown[]).filter((v): v is string => typeof v === 'string') : [];
    if (!key) continue;
    if (e.operator === 'In') parts.push(`${key} in (${values.join(',')})`);
    else if (e.operator === 'NotIn') parts.push(`${key} notin (${values.join(',')})`);
    else if (e.operator === 'Exists') parts.push(key);
    else if (e.operator === 'DoesNotExist') parts.push(`!${key}`);
  }
  return parts.length ? parts.join(',') : null;
}

/** A Service's `spec.selector` (a plain map) as a selector string. */
export function mapSelectorString(selector: unknown): string | null {
  return selectorString({ matchLabels: obj(selector) });
}

function formatTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '—';
}

function formatBytes(n: number): string {
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GiB`;
  if (n >= 2 ** 20) return `${Math.round(n / 2 ** 20)} MiB`;
  return `${Math.round(n / 1024)} KiB`;
}

/** The handful of facts the detail panel leads with, per kind. Never a Secret value. */
export function objectFacts(o: KubeObject): KubeFact[] {
  const spec = obj(o.spec);
  const status = obj(o.status);
  const facts: KubeFact[] = [];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== '') facts.push({ label, value: String(value) });
  };
  switch (o.kind) {
    case 'Pod': {
      const h = podHealth(o);
      add('Status', h.reason ? `${str(status.phase) ?? 'Unknown'} (${h.reason})` : (str(status.phase) ?? 'Unknown'));
      add('Ready', `${h.readyContainers}/${h.totalContainers} containers`);
      add('Restarts', h.restarts);
      add('Node', str(spec.nodeName) ?? 'not scheduled');
      add('Pod IP', str(status.podIP));
      add('QoS class', str(status.qosClass));
      add('Images', arr(spec.containers).map((c) => str(c.image)).filter(Boolean).join(', '));
      if (h.message) add('Message', h.message);
      break;
    }
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'Job':
    case 'CronJob': {
      const kind = o.kind as KubeWorkloadKind;
      const h = workloadHealth(kind, o);
      // The health itself is the panel's badge; this says what it rests on
      add('Status', h.summary);
      if (kind === 'Deployment') add('Strategy', str(obj(spec.strategy).type));
      if (kind === 'CronJob') {
        add('Schedule', str(spec.schedule));
        add('Last run', h.lastRunAt ? formatTime(h.lastRunAt) : 'never');
      }
      add('Images', templateImages(kind, o).join(', '));
      add('Selector', selectorString(spec.selector));
      break;
    }
    case 'ReplicaSet':
      add('Replicas', `${num(status.readyReplicas)} of ${num(spec.replicas, 1)} ready`);
      add('Revision', o.metadata.annotations?.['deployment.kubernetes.io/revision']);
      break;
    case 'Service': {
      add('Type', str(spec.type) ?? 'ClusterIP');
      add('Cluster IP', str(spec.clusterIP));
      add(
        'Ports',
        arr(spec.ports)
          .map((p) => `${num(p.port)}${p.targetPort !== undefined ? `→${String(p.targetPort)}` : ''}/${str(p.protocol) ?? 'TCP'}`)
          .join(', '),
      );
      add('Selector', mapSelectorString(spec.selector) ?? 'none (endpoints managed by hand)');
      const lb = arr(obj(status.loadBalancer).ingress).map((i) => str(i.ip) ?? str(i.hostname)).filter(Boolean);
      if (lb.length) add('External address', lb.join(', '));
      break;
    }
    case 'Ingress': {
      add('Class', str(spec.ingressClassName));
      add('Hosts', arr(spec.rules).map((r) => str(r.host) ?? '*').join(', '));
      break;
    }
    case 'Node': {
      const info = obj(status.nodeInfo);
      const allocatable = obj(status.allocatable);
      add('Roles', nodeRoles(o).join(', '));
      add('Ready', arr(status.conditions).find((c) => c.type === 'Ready')?.status === 'True' ? 'Yes' : 'No');
      add('Schedulable', spec.unschedulable === true ? 'No (cordoned)' : 'Yes');
      add('Kubelet', str(info.kubeletVersion));
      add('OS', str(info.osImage));
      add('CPU', `${cpuMillis(allocatable.cpu) / 1000} cores allocatable`);
      add('Memory', `${formatBytes(bytes(allocatable.memory))} allocatable`);
      break;
    }
    case 'Namespace':
      add('Phase', str(status.phase));
      break;
    case 'ConfigMap':
      add('Keys', Object.keys({ ...obj(o.data), ...obj(o.binaryData) }).join(', ') || 'none');
      break;
    case 'Secret':
      add('Type', str(o.type));
      add('Keys', Object.keys(obj(o.data)).join(', ') || 'none');
      add('Values', 'Never shown in BastionSSH');
      break;
    case 'PersistentVolumeClaim':
      add('Status', str(status.phase));
      add('Storage class', str(spec.storageClassName));
      add('Requested', str(obj(obj(spec.resources).requests).storage));
      add('Volume', str(spec.volumeName));
      break;
    case 'PersistentVolume':
      add('Status', str(status.phase));
      add('Capacity', str(obj(spec.capacity).storage));
      add('Claim', str(obj(spec.claimRef).name) ? `${str(obj(spec.claimRef).namespace)}/${str(obj(spec.claimRef).name)}` : null);
      break;
    case 'HorizontalPodAutoscaler': {
      const target = obj(spec.scaleTargetRef);
      add('Target', `${str(target.kind)}/${str(target.name)}`);
      add('Replicas', `${num(status.currentReplicas)} (min ${num(spec.minReplicas, 1)}, max ${num(spec.maxReplicas)})`);
      break;
    }
  }
  add('Created', formatTime(o.metadata.creationTimestamp));
  return facts;
}

type Related = KubeObjectRef & { relation: string };

function ref(kind: string, namespace: string | null, name: string, relation: string): Related | null {
  const resource = kubeResourceOfKind(kind);
  if (!resource) return null;
  // A static pod is owned by its Node: cluster-scoped, whatever namespace the pod is in
  return { resource, kind, namespace: KUBE_RESOURCES[resource].namespaced ? namespace : null, name, relation };
}

/** What an object points at by itself: owners, its node, volumes and env references, backends. */
export function directRelations(o: KubeObject): Related[] {
  const ns = o.metadata.namespace ?? null;
  const out: (Related | null)[] = [];
  for (const owner of o.metadata.ownerReferences ?? []) out.push(ref(owner.kind, ns, owner.name, 'owned by'));
  const spec = obj(o.spec);
  if (o.kind === 'Pod') {
    const node = str(spec.nodeName);
    if (node) out.push(ref('Node', null, node, 'runs on'));
    for (const v of arr(spec.volumes)) {
      const claim = str(obj(v.persistentVolumeClaim).claimName);
      if (claim) out.push(ref('PersistentVolumeClaim', ns, claim, 'mounts'));
      const cm = str(obj(v.configMap).name);
      if (cm) out.push(ref('ConfigMap', ns, cm, 'mounts'));
      const secret = str(obj(v.secret).secretName);
      if (secret) out.push(ref('Secret', ns, secret, 'mounts'));
    }
    for (const c of [...arr(spec.initContainers), ...arr(spec.containers)]) {
      for (const from of arr(c.envFrom)) {
        const cm = str(obj(from.configMapRef).name);
        if (cm) out.push(ref('ConfigMap', ns, cm, 'reads env from'));
        const secret = str(obj(from.secretRef).name);
        if (secret) out.push(ref('Secret', ns, secret, 'reads env from'));
      }
      for (const env of arr(c.env)) {
        const valueFrom = obj(env.valueFrom);
        const cm = str(obj(valueFrom.configMapKeyRef).name);
        if (cm) out.push(ref('ConfigMap', ns, cm, 'reads env from'));
        const secret = str(obj(valueFrom.secretKeyRef).name);
        if (secret) out.push(ref('Secret', ns, secret, 'reads env from'));
      }
    }
  }
  if (o.kind === 'Ingress') {
    const backends = [obj(spec.defaultBackend), ...arr(spec.rules).flatMap((r) => arr(obj(r.http).paths).map((p) => obj(p.backend)))];
    for (const b of backends) {
      const svc = str(obj(b.service).name);
      if (svc) out.push(ref('Service', ns, svc, 'routes to'));
    }
  }
  if (o.kind === 'PersistentVolumeClaim') {
    const volume = str(spec.volumeName);
    if (volume) out.push(ref('PersistentVolume', null, volume, 'bound to'));
  }
  if (o.kind === 'HorizontalPodAutoscaler') {
    const target = obj(spec.scaleTargetRef);
    if (str(target.kind) && str(target.name)) out.push(ref(str(target.kind)!, ns, str(target.name)!, 'scales'));
  }
  // One entry per object and relation
  const seen = new Set<string>();
  return out.filter((r): r is Related => {
    if (!r) return false;
    const key = `${r.relation}|${r.resource}|${r.namespace}|${r.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** How to find the pods an object selects or owns: a selector, or a node. */
export function podQueryFor(o: KubeObject): { labelSelector?: string; fieldSelector?: string } | null {
  const spec = obj(o.spec);
  switch (o.kind) {
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'ReplicaSet':
    case 'Job': {
      const selector = selectorString(spec.selector);
      return selector ? { labelSelector: selector } : null;
    }
    case 'Service': {
      const selector = mapSelectorString(spec.selector);
      return selector ? { labelSelector: selector } : null;
    }
    case 'Node':
      return { fieldSelector: `spec.nodeName=${o.metadata.name}` };
    default:
      return null;
  }
}

/** Resources whose objects are listed for "what this owns" (by ownerReferences). */
export const OWNED_KINDS: Partial<Record<string, KubeResource>> = {
  Deployment: 'replicasets',
  CronJob: 'jobs',
};
