import type {
  KubeClaimItem,
  KubeConfigItem,
  KubeConfigView,
  KubeConsumer,
  KubeMissingConfig,
  KubeObjectRef,
  KubeResource,
  KubeStorageClassItem,
  KubeStorageView,
  KubeVolumeItem,
} from '@smt/shared';
import type { KubeObject } from './client.js';
import { WORKLOADS, podSpecRefs, template, type ObjectsByResource } from './graph.js';
import { diagnose, ownerResolver, refKey, refOf } from './health.js';

/**
 * The Storage and Config tabs (spec §5.5): the objects behind an app that
 * the topology graph only shows as side links, listed with who uses them.
 *
 * - Config: ConfigMaps and Secrets by name and **key names only** — no value
 *   is ever copied here (the cache already holds Secrets redacted, and this
 *   module reads nothing but keys) — plus references to ones that do not
 *   exist, which stop pods from starting.
 * - Storage: claims with the volume behind them, the pods that mount them and
 *   why a pending one has no storage (the §5.4 diagnosis); volumes no claim
 *   holds; storage classes, with which one is the default.
 *
 * "Used by" comes from the same references as the graph's edges
 * (graph.ts `podSpecRefs`): a workload's pod template, and running pods —
 * attributed to the workload that owns them, so a StatefulSet's per-pod
 * claims count towards the StatefulSet.
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** What the Storage tab reads. */
export const STORAGE_RESOURCES: KubeResource[] = [
  'persistentvolumeclaims',
  'persistentvolumes',
  'storageclasses',
  'events',
  'pods',
  'replicasets',
  ...WORKLOADS.map((w) => w.resource),
];

/** What the Config tab reads. */
export const CONFIG_RESOURCES: KubeResource[] = ['configmaps', 'secrets', 'pods', 'replicasets', ...WORKLOADS.map((w) => w.resource)];

const DEFAULT_CLASS_ANNOTATIONS = ['storageclass.kubernetes.io/is-default-class', 'storageclass.beta.kubernetes.io/is-default-class'];

type RefKind = 'ConfigMap' | 'Secret' | 'PersistentVolumeClaim';

/** Who uses which ConfigMap, Secret or claim, keyed by `<kind>/<namespace>/<name>`; references marked optional are left out of `required`. */
export function consumersOf(objects: ObjectsByResource): { usedBy: Map<string, KubeConsumer[]>; required: Set<string> } {
  const usedBy = new Map<string, KubeConsumer[]>();
  const required = new Set<string>();
  const add = (consumer: KubeObjectRef, ns: string | null, spec: Json) => {
    for (const r of podSpecRefs(spec)) {
      const key = `${r.kind}/${ns ?? ''}/${r.name}`;
      if (!r.optional) required.add(key);
      const list = usedBy.get(key) ?? [];
      let entry = list.find((c) => refKey(c.ref) === refKey(consumer));
      if (!entry) {
        entry = { ref: consumer, how: [] };
        list.push(entry);
      }
      const how = r.relation === 'env' ? 'env' : 'mounts';
      if (!entry.how.includes(how)) entry.how.push(how);
      usedBy.set(key, list);
    }
  };

  for (const { resource, kind } of WORKLOADS) {
    for (const w of objects[resource] ?? []) {
      const ns = w.metadata.namespace ?? null;
      // A CronJob's Jobs run its template: counted once, on the CronJob
      if (kind === 'Job' && (w.metadata.ownerReferences ?? []).some((o) => o.kind === 'CronJob')) continue;
      const ref = refOf(kind, ns, w.metadata.name);
      if (ref) add(ref, ns, template(kind, w).spec);
    }
  }
  // Running pods: what the template does not say (a StatefulSet's per-pod claims), on the workload that owns them
  const ownerOf = ownerResolver(objects.replicasets ?? [], objects.jobs ?? []);
  for (const pod of objects.pods ?? []) {
    const ns = pod.metadata.namespace ?? null;
    const owner = ownerOf(pod);
    // An owner of a kind the app does not read (a custom controller): the pod itself
    add((owner && refOf(owner.kind, ns, owner.name)) || refOf('Pod', ns, pod.metadata.name)!, ns, obj(pod.spec));
  }
  for (const list of usedBy.values()) list.sort((a, b) => refKey(a.ref).localeCompare(refKey(b.ref)));
  return { usedBy, required };
}

const byName = (a: { ref: KubeObjectRef }, b: { ref: KubeObjectRef }) =>
  (a.ref.namespace ?? '').localeCompare(b.ref.namespace ?? '') || a.ref.name.localeCompare(b.ref.name);

/** The Config tab. Only key names are read from ConfigMaps and Secrets. */
export function buildConfigView(objects: ObjectsByResource, warnings: string[] = []): KubeConfigView {
  const { usedBy, required } = consumersOf(objects);
  const item = (kind: 'ConfigMap' | 'Secret', o: KubeObject): KubeConfigItem => {
    const ns = o.metadata.namespace ?? null;
    const maps = kind === 'Secret' ? [o.data, o.stringData] : [o.data, o.binaryData];
    return {
      ref: refOf(kind, ns, o.metadata.name)!,
      type: kind === 'Secret' ? (str(o.type) ?? 'Opaque') : null,
      keys: [...new Set(maps.flatMap((m) => Object.keys(obj(m))))].sort(),
      usedBy: usedBy.get(`${kind}/${ns ?? ''}/${o.metadata.name}`) ?? [],
      createdAt: o.metadata.creationTimestamp ?? null,
    };
  };
  const configMaps = (objects.configmaps ?? []).map((o) => item('ConfigMap', o)).sort(byName);
  const secrets = (objects.secrets ?? []).map((o) => item('Secret', o)).sort(byName);

  // References to ones that do not exist — only where the kind could be listed
  const present = new Set([...configMaps, ...secrets].map((i) => refKey(i.ref)));
  const missing: KubeMissingConfig[] = [];
  for (const [key, consumers] of usedBy) {
    const [kind, ns, ...rest] = key.split('/') as [RefKind, string, ...string[]];
    if (kind === 'PersistentVolumeClaim' || present.has(key) || !required.has(key)) continue;
    if ((kind === 'ConfigMap' ? objects.configmaps : objects.secrets) == null) continue;
    missing.push({ kind, namespace: ns || null, name: rest.join('/'), usedBy: consumers });
  }
  missing.sort((a, b) => (a.namespace ?? '').localeCompare(b.namespace ?? '') || a.name.localeCompare(b.name));
  return { configMaps, secrets, missing, warnings, generatedAt: new Date().toISOString() };
}

/**
 * The Storage tab. `coversCluster`: no namespace was picked, so volumes no
 * visible claim holds are listed too (a volume has no namespace of its own).
 */
export function buildStorageView(objects: ObjectsByResource, warnings: string[] = [], coversCluster = true): KubeStorageView {
  const { usedBy } = consumersOf(objects);
  const claims = objects.persistentvolumeclaims ?? [];
  const volumes = objects.persistentvolumes;
  const classes = objects.storageclasses ?? null;
  const defaultClass = classes?.find((c) => DEFAULT_CLASS_ANNOTATIONS.some((a) => c.metadata.annotations?.[a] === 'true'))?.metadata.name ?? null;

  const problems = new Map(
    diagnose({ pods: [], podsListed: false, nodes: null, events: objects.events ?? [], claims, storageClasses: classes }).map((d) => [
      refKey(d.subject),
      d,
    ]),
  );

  const claimItems: KubeClaimItem[] = claims.map((c) => {
    const ns = c.metadata.namespace ?? null;
    const spec = obj(c.spec);
    const status = obj(c.status);
    const ref = refOf('PersistentVolumeClaim', ns, c.metadata.name)!;
    const volumeName = str(spec.volumeName);
    const pv = volumeName && volumes ? (volumes.find((v) => v.metadata.name === volumeName) ?? null) : null;
    return {
      ref,
      phase: str(status.phase) ?? 'Pending',
      requested: str(obj(obj(spec.resources).requests).storage),
      capacity: str(obj(status.capacity).storage),
      storageClass: typeof spec.storageClassName === 'string' ? spec.storageClassName : null,
      accessModes: strings(spec.accessModes),
      volume: volumeName
        ? {
            name: volumeName,
            phase: pv ? str(obj(pv.status).phase) : null,
            reclaimPolicy: pv ? str(obj(pv.spec).persistentVolumeReclaimPolicy) : null,
            // Unknown when volumes could not be listed: not called missing
            exists: volumes == null || !!pv,
          }
        : null,
      usedBy: usedBy.get(`PersistentVolumeClaim/${ns ?? ''}/${c.metadata.name}`) ?? [],
      problem: problems.get(refKey(ref)) ?? null,
      createdAt: c.metadata.creationTimestamp ?? null,
    };
  });
  claimItems.sort(byName);

  const held = new Set(claims.map((c) => str(obj(c.spec).volumeName)).filter(Boolean));
  const volumeItems: KubeVolumeItem[] = coversCluster
    ? (volumes ?? [])
        .filter((v) => !held.has(v.metadata.name))
        .map((v) => {
          const spec = obj(v.spec);
          const claimRef = obj(spec.claimRef);
          return {
            ref: refOf('PersistentVolume', null, v.metadata.name)!,
            phase: str(obj(v.status).phase) ?? 'Unknown',
            capacity: str(obj(spec.capacity).storage),
            storageClass: str(spec.storageClassName),
            reclaimPolicy: str(spec.persistentVolumeReclaimPolicy),
            claim: str(claimRef.name) ? { namespace: str(claimRef.namespace), name: str(claimRef.name)! } : null,
          };
        })
        .sort(byName)
    : [];

  const classItems: KubeStorageClassItem[] | null = classes
    ? classes
        .map((c) => ({
          name: c.metadata.name,
          provisioner: str(c.provisioner),
          isDefault: c.metadata.name === defaultClass,
          reclaimPolicy: str(c.reclaimPolicy),
          bindingMode: str(c.volumeBindingMode),
          claims: claimItems.filter((i) => (i.storageClass ?? defaultClass) === c.metadata.name).length,
        }))
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
    : null;

  return { claims: claimItems, volumes: volumeItems, classes: classItems, warnings, generatedAt: new Date().toISOString() };
}
