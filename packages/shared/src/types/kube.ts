import type { Role } from './auth.js';
import type { AlertSeverity } from './monitoring.js';

/**
 * Kubernetes clusters, understood visually: the app talks to the API server
 * directly over HTTPS (no kubectl), through a managed server's SSH connection
 * or a connectivity agent when the API is private. See docs/ARCHITECTURE.md
 * §4.16 and docs/superpowers/specs/2026-10-03-kubernetes-visual-design.md.
 */

/** How the API server is reached. */
export type KubeConnectVia = 'direct' | 'server' | 'agent';

/** A service account token, or a client certificate and key. */
export type KubeAuthType = 'token' | 'cert';

/** Last known health of a cluster, from its last test or use. */
export type KubeClusterStatus = 'ok' | 'error' | 'unknown';

// ── Org settings and permissions ─────────────────────────────────────────────

/** Org-wide Kubernetes permissions (owners and admins set them). */
export interface KubeSettings {
  /** Operators may open a shell inside a pod's container. */
  operatorsCanExec: boolean;
  /** Operators may delete (restart) pods. */
  operatorsCanDeletePods: boolean;
  /** Operators may scale, restart rollouts and trigger or suspend CronJobs. */
  operatorsCanScale: boolean;
  /** ConfigMap values are shown; off shows keys only. Secret values are never shown. */
  showConfigMapValues: boolean;
  /** The health check raises alerts for clusters (K5). Off by default. */
  clusterAlerts: boolean;
}

export const DEFAULT_KUBE_SETTINGS: KubeSettings = {
  operatorsCanExec: true,
  operatorsCanDeletePods: true,
  operatorsCanScale: true,
  showConfigMapValues: true,
  clusterAlerts: false,
};

/**
 * What a member may do with Kubernetes (spec §7). One matrix for the server's
 * gates and the UI's buttons:
 *
 * - `view` — cluster map, graph, workloads, events, health, redacted details
 * - `logs` — pod logs
 * - `yaml` — the read-only (redacted) YAML of an object
 * - `scale` — scale, restart a rollout, trigger or suspend a CronJob
 * - `deletePod` — delete (restart) a pod
 * - `rollback` — roll a Deployment back to an earlier revision
 * - `cordon` — cordon and uncordon nodes
 * - `exec` — a shell inside a pod's container
 * - `configure` — add, edit and remove clusters, credentials, impersonation
 */
export type KubeCapability =
  | 'view'
  | 'logs'
  | 'yaml'
  | 'scale'
  | 'deletePod'
  | 'rollback'
  | 'cordon'
  | 'exec'
  | 'configure';

export type KubePermissions = Record<KubeCapability, boolean>;

const KUBE_ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

/** The capabilities `role` has under `settings`. Unknown roles get nothing beyond viewing. */
export function kubePermissions(role: Role, settings: KubeSettings): KubePermissions {
  const rank = KUBE_ROLE_RANK[role] ?? 0;
  const operator = rank >= KUBE_ROLE_RANK.operator;
  const admin = rank >= KUBE_ROLE_RANK.admin;
  return {
    view: true,
    logs: operator,
    yaml: operator,
    scale: admin || (operator && settings.operatorsCanScale),
    deletePod: admin || (operator && settings.operatorsCanDeletePods),
    rollback: admin,
    cordon: admin,
    exec: admin || (operator && settings.operatorsCanExec),
    configure: admin,
  };
}

// ── Resources ────────────────────────────────────────────────────────────────

/**
 * Resources the app reads, by their URL name (the API's plural). Anything
 * else is refused before a URL is built (spec §8.5).
 */
export type KubeResource =
  | 'pods'
  | 'nodes'
  | 'namespaces'
  | 'deployments'
  | 'statefulsets'
  | 'daemonsets'
  | 'replicasets'
  | 'jobs'
  | 'cronjobs'
  | 'services'
  | 'endpoints'
  | 'ingresses'
  | 'configmaps'
  | 'secrets'
  | 'persistentvolumeclaims'
  | 'persistentvolumes'
  | 'storageclasses'
  | 'horizontalpodautoscalers'
  | 'events';

export interface KubeResourceInfo {
  kind: string;
  /** '' for the core group. */
  group: string;
  version: string;
  namespaced: boolean;
}

export const KUBE_RESOURCES: Record<KubeResource, KubeResourceInfo> = {
  pods: { kind: 'Pod', group: '', version: 'v1', namespaced: true },
  nodes: { kind: 'Node', group: '', version: 'v1', namespaced: false },
  namespaces: { kind: 'Namespace', group: '', version: 'v1', namespaced: false },
  deployments: { kind: 'Deployment', group: 'apps', version: 'v1', namespaced: true },
  statefulsets: { kind: 'StatefulSet', group: 'apps', version: 'v1', namespaced: true },
  daemonsets: { kind: 'DaemonSet', group: 'apps', version: 'v1', namespaced: true },
  replicasets: { kind: 'ReplicaSet', group: 'apps', version: 'v1', namespaced: true },
  jobs: { kind: 'Job', group: 'batch', version: 'v1', namespaced: true },
  cronjobs: { kind: 'CronJob', group: 'batch', version: 'v1', namespaced: true },
  services: { kind: 'Service', group: '', version: 'v1', namespaced: true },
  endpoints: { kind: 'Endpoints', group: '', version: 'v1', namespaced: true },
  ingresses: { kind: 'Ingress', group: 'networking.k8s.io', version: 'v1', namespaced: true },
  configmaps: { kind: 'ConfigMap', group: '', version: 'v1', namespaced: true },
  secrets: { kind: 'Secret', group: '', version: 'v1', namespaced: true },
  persistentvolumeclaims: { kind: 'PersistentVolumeClaim', group: '', version: 'v1', namespaced: true },
  persistentvolumes: { kind: 'PersistentVolume', group: '', version: 'v1', namespaced: false },
  storageclasses: { kind: 'StorageClass', group: 'storage.k8s.io', version: 'v1', namespaced: false },
  horizontalpodautoscalers: { kind: 'HorizontalPodAutoscaler', group: 'autoscaling', version: 'v2', namespaced: true },
  events: { kind: 'Event', group: '', version: 'v1', namespaced: true },
};

export function isKubeResource(value: string): value is KubeResource {
  return Object.prototype.hasOwnProperty.call(KUBE_RESOURCES, value);
}

/** The resource for a kind (`Deployment` → `deployments`), or null when it is not one the app reads. */
export function kubeResourceOfKind(kind: string): KubeResource | null {
  for (const [resource, info] of Object.entries(KUBE_RESOURCES)) {
    if (info.kind === kind) return resource as KubeResource;
  }
  return null;
}

/** Workload controllers listed on the Workloads tab. */
export type KubeWorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job' | 'CronJob';

export const KUBE_WORKLOAD_KINDS: readonly KubeWorkloadKind[] = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'];

/** One object, addressed. `namespace` is null for cluster-scoped objects. */
export interface KubeObjectRef {
  resource: KubeResource;
  kind: string;
  namespace: string | null;
  name: string;
}

/** Path segment for "no namespace" (cluster-scoped objects) in object URLs. */
export const KUBE_CLUSTER_SCOPE = '_';

/**
 * The stable, shareable URL path of an object, the same in the API and the
 * web app: `objects/<resource>/<namespace or _>/<name>`. The web prefixes
 * `/kubernetes/<clusterId>/`, the API `/api/kube/clusters/<clusterId>/`.
 */
export function kubeObjectPath(ref: Pick<KubeObjectRef, 'resource' | 'namespace' | 'name'>): string {
  const ns = ref.namespace ?? KUBE_CLUSTER_SCOPE;
  return `objects/${encodeURIComponent(ref.resource)}/${encodeURIComponent(ns)}/${encodeURIComponent(ref.name)}`;
}

/** The web app's URL for an object (see {@link kubeObjectPath}). */
export function kubeObjectUrl(clusterId: string, ref: Pick<KubeObjectRef, 'resource' | 'namespace' | 'name'>): string {
  return `/kubernetes/${encodeURIComponent(clusterId)}/${kubeObjectPath(ref)}`;
}

// ── Clusters ─────────────────────────────────────────────────────────────────

/** A cluster as the UI sees it. Credentials never leave the server; only a hint does. */
export interface KubeCluster {
  id: string;
  name: string;
  apiUrl: string;
  connectVia: KubeConnectVia;
  viaServerId: string | null;
  viaServerName: string | null;
  viaAgentId: string | null;
  viaAgentName: string | null;
  /** A CA from the kubeconfig is pinned; false means the system trust store. */
  hasCa: boolean;
  authType: KubeAuthType;
  /** `token ending …abcd`, `client certificate CN=admin` — never the credential. */
  credentialHint: string;
  impersonate: boolean;
  defaultNamespace: string;
  /** Namespaces anyone may see on this cluster; null = all. */
  namespacesAllowlist: string[] | null;
  lastStatus: KubeClusterStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  serverVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/kube/clusters/:id — the cluster and what the caller may do on it. */
export interface KubeClusterStatusView {
  cluster: KubeCluster;
  permissions: KubePermissions;
}

/**
 * Body of `POST /api/kube/clusters` and `PATCH /api/kube/clusters/:id`. The
 * connection comes from an uploaded kubeconfig (and one of its contexts) or
 * from the fields; on PATCH, credentials left out stay as they are.
 */
export interface KubeClusterInput {
  name?: string;
  /** A kubeconfig file's text; `context` picks one (default: its current-context). */
  kubeconfig?: string;
  context?: string;
  apiUrl?: string;
  /** PEM; '' returns to the system trust store. */
  caData?: string;
  token?: string;
  clientCert?: string;
  clientKey?: string;
  connectVia?: KubeConnectVia;
  viaServerId?: string | null;
  viaAgentId?: string | null;
  impersonate?: boolean;
  defaultNamespace?: string;
  namespacesAllowlist?: string[] | null;
}

/** One context of an uploaded kubeconfig, as offered for picking. */
export interface KubeconfigContext {
  name: string;
  cluster: string;
  user: string;
  namespace: string | null;
  server: string | null;
  authType: KubeAuthType | null;
  hasCa: boolean;
  /** Why this context cannot be used (exec plugin, insecure-skip-tls-verify…); null when it can. */
  problem: string | null;
}

/** POST /api/kube/kubeconfig/contexts — what is in an uploaded kubeconfig, nothing saved. */
export interface KubeconfigSummary {
  currentContext: string | null;
  contexts: KubeconfigContext[];
}

// ── Connection test ──────────────────────────────────────────────────────────

export type KubeTestStepId = 'reach' | 'tls' | 'auth' | 'version' | 'rules';

export interface KubeTestStep {
  id: KubeTestStepId;
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  detail: string;
  durationMs: number;
}

/** One thing the credential may or may not do, from the API server's own answer. */
export interface KubeCredentialCheck {
  id: string;
  label: string;
  allowed: boolean;
}

export interface KubeCredentialCapabilities {
  /** The namespace the namespaced checks were asked for. */
  namespace: string;
  checks: KubeCredentialCheck[];
  /** The API server said its answer may be incomplete (webhook authorizers). */
  incomplete: boolean;
}

/** POST /api/kube/clusters/:id/test */
export interface KubeTestResult {
  ok: boolean;
  steps: KubeTestStep[];
  serverVersion: string | null;
  capabilities: KubeCredentialCapabilities | null;
  checkedAt: string;
}

// ── Views ────────────────────────────────────────────────────────────────────

/**
 * A pod tile's colour on the cluster map (spec §5.1): green running and
 * ready, amber pending or starting, red failing (CrashLoopBackOff, Error,
 * OOMKilled…), grey completed, purple terminating.
 */
export type KubePodTileStatus = 'running' | 'pending' | 'failing' | 'completed' | 'terminating';

export interface KubePodTile {
  namespace: string;
  name: string;
  status: KubePodTileStatus;
  /** Pod phase as Kubernetes reports it. */
  phase: string;
  /** The most telling reason: CrashLoopBackOff, OOMKilled, Unschedulable…; null when all is well. */
  reason: string | null;
  restarts: number;
  /** Ready containers / containers. */
  readyContainers: number;
  totalContainers: number;
  nodeName: string | null;
  /** The controller that owns it (ReplicaSet, StatefulSet, Job…). */
  owner: { kind: string; name: string } | null;
  /** For pods waiting for a node: the scheduler's message. */
  message: string | null;
  createdAt: string | null;
}

export interface KubeResourceAmounts {
  /** CPU in millicores. */
  cpuMillis: number;
  memoryBytes: number;
}

export interface KubeNodeCard {
  name: string;
  roles: string[];
  ready: boolean;
  /** Cordoned: no new pods are scheduled here. */
  unschedulable: boolean;
  /** MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable when true. */
  pressures: string[];
  kubeletVersion: string | null;
  osImage: string | null;
  architecture: string | null;
  allocatable: KubeResourceAmounts & { pods: number };
  /** Sum of the requests of the pods placed here (not completed). */
  requested: KubeResourceAmounts;
  /** Live usage from metrics.k8s.io; null when metrics are not available. */
  usage: KubeResourceAmounts | null;
  pods: KubePodTile[];
}

/** GET /api/kube/clusters/:id/overview — the cluster map. */
export interface KubeOverview {
  clusterId: string;
  serverVersion: string | null;
  metricsAvailable: boolean;
  /** Namespaces the caller may pick from (after the cluster's allowlist). */
  namespaces: string[];
  nodes: KubeNodeCard[];
  /** Pods no node has taken: the "Waiting for a node" lane. */
  unscheduled: KubePodTile[];
  /** What could not be read with this credential (nodes not listable, …); empty when nothing. */
  warnings: string[];
  generatedAt: string;
}

export interface KubeNamespace {
  name: string;
  phase: string;
  createdAt: string | null;
  labels: Record<string, string>;
}

/** Health of a workload at a glance (the Workloads list's dot). */
export type KubeWorkloadHealth = 'healthy' | 'progressing' | 'degraded' | 'failed' | 'suspended' | 'completed' | 'idle';

export interface KubeWorkload {
  kind: KubeWorkloadKind;
  namespace: string;
  name: string;
  health: KubeWorkloadHealth;
  /** One line: "2 of 3 ready", "Last run 5 min ago", "Completed 3/3". */
  summary: string;
  desired: number | null;
  ready: number | null;
  images: string[];
  createdAt: string | null;
  /** CronJobs: when it last ran. */
  lastRunAt: string | null;
}

/** GET /api/kube/clusters/:id/workloads */
export interface KubeWorkloadList {
  workloads: KubeWorkload[];
  /** Kinds this credential may not list, in plain words; empty when nothing was hidden. */
  warnings: string[];
}

export interface KubeFact {
  label: string;
  value: string;
}

/** GET /api/kube/clusters/:id/objects/:resource/:namespace/:name */
export interface KubeObjectDetail {
  ref: KubeObjectRef;
  /** Health in a word, when the kind has one. */
  health: KubeWorkloadHealth | KubePodTileStatus | null;
  facts: KubeFact[];
  labels: Record<string, string>;
  /** Owner chain upwards, and what it owns or selects (pods of a workload, pods behind a service). */
  related: (KubeObjectRef & { relation: string })[];
}

/**
 * Events on the cluster change feed (`GET …/stream?view=`): the browser
 * refetches the view's snapshot on `changed`, so nothing large is pushed.
 */
export type KubeStreamEvent =
  | { type: 'ready' }
  | { type: 'changed'; resources: KubeResource[] }
  | { type: 'error'; error: string; status?: number }
  | { type: 'end' };

/**
 * Views the change feed can follow: `overview` (nodes and pods), `workloads`
 * (`namespace` optional), `namespaces`, and `object` (`resource`,
 * `namespace`, `name` — the object and the pods around it). K2 adds
 * `graph`, `events` and `attention`, and the Storage and Config tabs
 * `storage` and `config` (`namespace` optional).
 */
export type KubeStreamView = 'overview' | 'workloads' | 'namespaces' | 'object' | 'graph' | 'events' | 'attention' | 'storage' | 'config';

// ── Understanding (K2): topology, diagnoses, events, attention ──────────────

/**
 * Plain-language problems (spec §5.4), one id per rule. Built from what the
 * API server reports; no AI involved.
 */
export type KubeDiagnosisId =
  | 'crash-loop'
  | 'image-pull'
  | 'oom-killed'
  | 'unschedulable-resources'
  | 'unschedulable-placement'
  | 'unschedulable'
  | 'readiness-failing'
  | 'service-no-endpoints'
  | 'pvc-pending'
  | 'node-not-ready'
  | 'node-pressure'
  | 'rollout-stuck';

/** `critical`: something is down or cannot start; `warning`: degraded or at risk. */
export type KubeSeverity = 'critical' | 'warning';

/** What a diagnosis rests on: an object (a link), an event, or a fact read from the object. */
export interface KubeEvidence {
  type: 'object' | 'event' | 'fact';
  label: string;
  detail: string | null;
  ref: KubeObjectRef | null;
}

export interface KubeDiagnosis {
  id: KubeDiagnosisId;
  severity: KubeSeverity;
  /** The object the problem is about (a pod, a Service, a node…). */
  subject: KubeObjectRef;
  /** The workload behind a pod, when it has one: problems of its pods add up there. */
  owner: KubeObjectRef | null;
  /** One sentence; `backticks` mark names and values. */
  headline: string;
  cause: string;
  nextStep: string;
  evidence: KubeEvidence[];
  /** Last lines of the crashed container's previous run (crash loops; operators and up, when logs can be read). */
  logTail?: string[];
  /** How many objects share this problem (the attention list merges a workload's pods); 1 otherwise. */
  affected: number;
  /** When the problem was last seen (newest related event, or the condition's change). */
  since: string | null;
}

/** GET /api/kube/clusters/:id/attention — problems ranked across namespaces. */
export interface KubeAttentionList {
  items: KubeDiagnosis[];
  warnings: string[];
  generatedAt: string;
}

/** Health colour of a node of the topology graph. */
export type KubeGraphHealth = 'healthy' | 'progressing' | 'warning' | 'failing' | 'idle' | 'missing';

/** How two nodes of the topology graph are related (spec §5.2). */
export type KubeGraphRelation = 'routes' | 'selects' | 'owns' | 'mounts' | 'env' | 'bound' | 'scales';

/** Pods of one workload, collapsed into a replica ring (expanded on click). */
export interface KubePodGroup {
  ready: number;
  total: number;
  /** Replicas asked for, when the owner says. */
  desired: number | null;
  counts: Record<KubePodTileStatus, number>;
  /** Up to {@link KUBE_GRAPH_MAX_GROUP_PODS} pods, problems first. */
  pods: KubePodTile[];
}

/** Pods listed per group in the graph; the ring's counts still cover every pod. */
export const KUBE_GRAPH_MAX_GROUP_PODS = 300;

export interface KubeGraphNode {
  /** Stable across refreshes: `<kind>/<namespace>/<name>`, `pods:<owner id>`, `missing:<kind>/<namespace>/<name>`. */
  id: string;
  /** Kubernetes kind, or `Pods` for a replica ring. */
  kind: string;
  name: string;
  namespace: string | null;
  /** The object to open; null for a replica ring or something that does not exist. */
  ref: KubeObjectRef | null;
  health: KubeGraphHealth;
  /** One line: "2 of 3 ready", "ClusterIP 10.0.0.12", "Bound 10Gi". */
  summary: string;
  /** Problems (diagnoses) on this object, or its pods. */
  problems: number;
  /** Replica ring nodes only. */
  pods?: KubePodGroup;
}

export interface KubeGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: KubeGraphRelation;
  /** Leads nowhere (a Service no ready pod answers, an Ingress to a missing Service…): drawn dashed red. */
  broken: boolean;
  /** Why it is broken, or what the link means, in plain words. */
  explanation: string;
}

/** GET /api/kube/clusters/:id/graph?namespace= — the app topology (spec §5.2). */
export interface KubeGraph {
  namespace: string | null;
  nodes: KubeGraphNode[];
  edges: KubeGraphEdge[];
  /** Kinds the credential may not list, in plain words. */
  warnings: string[];
  generatedAt: string;
}

/** One line of the events timeline: repeats of the same event on the same object collapsed with a count. */
export interface KubeEventEntry {
  type: 'Normal' | 'Warning';
  reason: string;
  message: string;
  /** Times it happened (the API's own count plus collapsed repeats). */
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** Who reported it (kubelet, default-scheduler…). */
  source: string | null;
}

export interface KubeEventGroup {
  /** The object the events are about; `resource` is null for kinds the app does not read. */
  object: Omit<KubeObjectRef, 'resource'> & { resource: KubeResource | null };
  warnings: number;
  lastSeen: string | null;
  events: KubeEventEntry[];
}

/** GET /api/kube/clusters/:id/events?namespace=&since= — grouped by object, newest first. */
export interface KubeEventList {
  groups: KubeEventGroup[];
  warnings: string[];
  generatedAt: string;
}

export interface KubeRollout {
  /** The Deployment's current revision. */
  current: number | null;
  /** A rollout is under way. */
  inProgress: boolean;
  /** Desired / updated / ready / available, for the stacked bar. */
  replicas: { desired: number; updated: number; ready: number; available: number };
  /** Newest first. */
  revisions: KubeRevision[];
}

export type KubeLifecycleStepId = 'scheduled' | 'pulled' | 'started' | 'ready';

/** One step of a pod's lifecycle strip: Scheduled → Pulled → Started → Ready. */
export interface KubeLifecycleStep {
  id: KubeLifecycleStepId;
  label: string;
  state: 'done' | 'current' | 'failed' | 'waiting';
  at: string | null;
  detail: string | null;
}

/** A container lane of the pod panel: init containers first, then the app, then sidecars. */
export interface KubeContainerLane {
  name: string;
  role: 'init' | 'app' | 'sidecar';
  image: string | null;
  state: 'running' | 'waiting' | 'terminated' | 'unknown';
  /** Waiting or terminated reason (CrashLoopBackOff, Completed…). */
  reason: string | null;
  ready: boolean;
  restarts: number;
  lastTermination: { reason: string | null; exitCode: number | null; finishedAt: string | null } | null;
}

/**
 * GET /api/kube/clusters/:id/objects/:resource/:ns/:name/insight — what is
 * wrong with an object and what happened to it: diagnoses, its events
 * (collapsed), and per kind the rollout timeline or the pod lifecycle.
 */
export interface KubeObjectInsight {
  diagnoses: KubeDiagnosis[];
  events: KubeEventEntry[];
  rollout?: KubeRollout;
  lifecycle?: KubeLifecycleStep[];
  containers?: KubeContainerLane[];
}

// ── Storage and Config tabs ──────────────────────────────────────────────────

/** What reads a ConfigMap, Secret or claim: a workload (through its pod template) or a pod no workload owns. */
export interface KubeConsumer {
  ref: KubeObjectRef;
  /** `mounts`: as files in a volume; `env`: as environment variables. */
  how: ('mounts' | 'env')[];
}

export interface KubeConfigItem {
  ref: KubeObjectRef;
  /** Secrets: their type (`Opaque`, `kubernetes.io/tls`…); null for ConfigMaps. */
  type: string | null;
  /** Key names only. Secret values never leave the server; a ConfigMap's values are on its YAML tab. */
  keys: string[];
  usedBy: KubeConsumer[];
  createdAt: string | null;
}

/** A ConfigMap or Secret a workload reads that does not exist: its pods cannot start. */
export interface KubeMissingConfig {
  kind: 'ConfigMap' | 'Secret';
  namespace: string | null;
  name: string;
  usedBy: KubeConsumer[];
}

/** GET /api/kube/clusters/:id/config?namespace= — ConfigMaps and Secrets (names and keys) and who reads them. */
export interface KubeConfigView {
  configMaps: KubeConfigItem[];
  secrets: KubeConfigItem[];
  missing: KubeMissingConfig[];
  warnings: string[];
  generatedAt: string;
}

export interface KubeClaimItem {
  ref: KubeObjectRef;
  /** `Pending`, `Bound` or `Lost`. */
  phase: string;
  /** Size asked for, and the size it got once bound. */
  requested: string | null;
  capacity: string | null;
  /** The class it names; null when it names none (the cluster's default applies). */
  storageClass: string | null;
  accessModes: string[];
  /** The volume it is bound to. */
  volume: { name: string; phase: string | null; reclaimPolicy: string | null; exists: boolean } | null;
  usedBy: KubeConsumer[];
  /** Why it has no storage (spec §5.4), when that is a problem. */
  problem: KubeDiagnosis | null;
  createdAt: string | null;
}

/** A volume no visible claim is bound to (Available, Released, Failed). */
export interface KubeVolumeItem {
  ref: KubeObjectRef;
  phase: string;
  capacity: string | null;
  storageClass: string | null;
  reclaimPolicy: string | null;
  /** The claim it was last bound to, for a Released volume. */
  claim: { namespace: string | null; name: string } | null;
}

export interface KubeStorageClassItem {
  name: string;
  provisioner: string | null;
  isDefault: boolean;
  reclaimPolicy: string | null;
  /** `Immediate`, or `WaitForFirstConsumer` (a claim stays Pending until a pod uses it). */
  bindingMode: string | null;
  /** Visible claims that use it (by name, or as the default). */
  claims: number;
}

/** GET /api/kube/clusters/:id/storage?namespace= — claims, the volumes behind them, storage classes, and the pods that mount them. */
export interface KubeStorageView {
  claims: KubeClaimItem[];
  /** Only without a namespace picked: a volume has no namespace of its own. */
  volumes: KubeVolumeItem[];
  /** Null when the credential may not list them. */
  classes: KubeStorageClassItem[] | null;
  warnings: string[];
  generatedAt: string;
}

// ── Guided actions (K3) ──────────────────────────────────────────────────────

/**
 * The guided actions (spec §6), by their route name:
 * `POST /api/kube/clusters/:id/actions/<action>`.
 */
export type KubeActionId =
  | 'scale'
  | 'restart'
  | 'rollback'
  | 'delete-pod'
  | 'cordon'
  | 'uncordon'
  | 'suspend-cronjob'
  | 'trigger-cronjob';

export const KUBE_ACTIONS: readonly KubeActionId[] = [
  'scale',
  'restart',
  'rollback',
  'delete-pod',
  'cordon',
  'uncordon',
  'suspend-cronjob',
  'trigger-cronjob',
];

/** The capability each action needs (spec §7). */
export const KUBE_ACTION_CAPABILITY: Record<KubeActionId, KubeCapability> = {
  scale: 'scale',
  restart: 'scale',
  rollback: 'rollback',
  'delete-pod': 'deletePod',
  cordon: 'cordon',
  uncordon: 'cordon',
  'suspend-cronjob': 'scale',
  'trigger-cronjob': 'scale',
};

/** Workloads that can be scaled (through their `scale` subresource). */
export type KubeScalableKind = 'Deployment' | 'StatefulSet';
export const KUBE_SCALABLE_KINDS: readonly KubeScalableKind[] = ['Deployment', 'StatefulSet'];

/** Workloads whose rollout can be restarted. */
export type KubeRestartableKind = 'Deployment' | 'StatefulSet' | 'DaemonSet';
export const KUBE_RESTARTABLE_KINDS: readonly KubeRestartableKind[] = ['Deployment', 'StatefulSet', 'DaemonSet'];

/** A workload's update strategy (`spec.strategy.type` / `spec.updateStrategy.type`). */
export type KubeUpdateStrategy = 'RollingUpdate' | 'Recreate' | 'OnDelete';

/** Most replicas the scale slider and route accept. */
export const KUBE_MAX_REPLICAS = 1000;

/** Body of `POST …/actions/scale`. */
export interface KubeScaleRequest {
  kind: KubeScalableKind;
  namespace: string;
  name: string;
  replicas: number;
}

/** Body of `POST …/actions/restart`. */
export interface KubeRestartRequest {
  kind: KubeRestartableKind;
  namespace: string;
  name: string;
}

/** Body of `POST …/actions/rollback`: a Deployment back to one of its revisions. */
export interface KubeRollbackRequest {
  namespace: string;
  name: string;
  revision: number;
}

/** Body of `POST …/actions/delete-pod`. */
export interface KubeDeletePodRequest {
  namespace: string;
  name: string;
}

/** Body of `POST …/actions/cordon` and `…/uncordon`. */
export interface KubeNodeActionRequest {
  name: string;
}

/** Body of `POST …/actions/suspend-cronjob`: `suspend: false` resumes it. */
export interface KubeSuspendCronJobRequest {
  namespace: string;
  name: string;
  suspend: boolean;
}

/** Body of `POST …/actions/trigger-cronjob`. */
export interface KubeTriggerCronJobRequest {
  namespace: string;
  name: string;
}

/** What an action did. `changed: false` when the object already was that way (nothing was sent). */
export interface KubeActionResult {
  action: KubeActionId;
  ref: KubeObjectRef;
  changed: boolean;
  /** The fields the action touches, before and after — the same values the audit log records. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** One line for a toast: "Scaled web from 2 to 3 replicas". */
  message: string;
  /** An object the action created (the Job a CronJob trigger starts). */
  created?: KubeObjectRef;
}

/** A container of a pod template, for comparing revisions: env var names only, never values. */
export interface KubeTemplateContainer {
  name: string;
  image: string;
  envNames: string[];
}

/**
 * One revision of a Deployment: a ReplicaSet it owns. The rollout timeline
 * (spec §5.3) and the rollback picker (§6) both show it.
 */
export interface KubeRevision {
  revision: number;
  replicaSet: string;
  createdAt: string | null;
  /** The `kubernetes.io/change-cause` annotation, when someone set it. */
  changeCause: string | null;
  /** Distinct images of its pod template. */
  images: string[];
  containers: KubeTemplateContainer[];
  /** Pods this revision runs now. */
  replicas: number;
  readyReplicas: number;
  /** The revision the Deployment's template is on. */
  current: boolean;
}

/**
 * GET /api/kube/clusters/:id/actions/preview/:resource/:namespace/:name —
 * what the action panels show before anything is done: the object's current
 * state, and which actions the caller may take on it. Never a Secret value
 * or an env value.
 */
export interface KubeActionPreview {
  ref: KubeObjectRef;
  /** Actions for this object that the caller's role and the org settings allow. */
  actions: KubeActionId[];
  /** Deployments, StatefulSets and DaemonSets (desired = scheduled for a DaemonSet). */
  replicas?: { desired: number; ready: number; updated: number; available: number };
  /** An autoscaler that controls the replicas: scaling by hand is undone by it. */
  hpa?: { name: string; minReplicas: number; maxReplicas: number } | null;
  /** A paused Deployment can be neither restarted nor rolled back. */
  paused?: boolean;
  /**
   * How a restart or rollback replaces the pods: `RollingUpdate` one by one,
   * `Recreate` (Deployments) all at once — the app is down meanwhile —
   * `OnDelete` (StatefulSets, DaemonSets) only as each pod is deleted.
   */
  strategy?: KubeUpdateStrategy;
  /** Deployments: their revisions, newest first. */
  revisions?: KubeRevision[];
  /**
   * Pods: who owns it (null: a bare pod), and whether deleting it brings a
   * fresh one — not for a bare pod, nor for one whose Job already finished.
   */
  pod?: { owner: { kind: string; name: string } | null; recreated: boolean; nodeName: string | null; phase: string };
  /** Nodes: whether cordoned, and what runs there. */
  node?: { unschedulable: boolean; pods: number; daemonSetPods: number };
  /** CronJobs. */
  cronJob?: { suspended: boolean; schedule: string; lastScheduleTime: string | null; active: number };
}

/** The object an action takes: its kind, namespace (`null` for nodes) and name. */
export interface KubeActionTarget {
  kind: string;
  namespace: string | null;
  name: string;
}

/** Quote a shell argument when it needs it (display only). */
function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The kubectl command an action is equivalent to, for the "What this does"
 * panel (spec §2.2) — for learning and auditing; nothing ever runs it.
 */
export function kubeActionCommand(
  action: KubeActionId,
  target: KubeActionTarget,
  opts: { replicas?: number; revision?: number; suspend?: boolean; jobName?: string } = {},
): string {
  const ns = target.namespace ? ` -n ${shellArg(target.namespace)}` : '';
  const obj = `${target.kind.toLowerCase()}/${shellArg(target.name)}`;
  switch (action) {
    case 'scale':
      return `kubectl scale ${obj} --replicas=${opts.replicas ?? 0}${ns}`;
    case 'restart':
      return `kubectl rollout restart ${obj}${ns}`;
    case 'rollback':
      return `kubectl rollout undo ${obj}${opts.revision ? ` --to-revision=${opts.revision}` : ''}${ns}`;
    case 'delete-pod':
      return `kubectl delete pod ${shellArg(target.name)}${ns}`;
    case 'cordon':
      return `kubectl cordon ${shellArg(target.name)}`;
    case 'uncordon':
      return `kubectl uncordon ${shellArg(target.name)}`;
    case 'suspend-cronjob':
      return `kubectl patch cronjob/${shellArg(target.name)}${ns} -p '${JSON.stringify({ spec: { suspend: opts.suspend ?? true } })}'`;
    case 'trigger-cronjob':
      return `kubectl create job ${shellArg(opts.jobName ?? `${target.name}-manual`)} --from=cronjob/${shellArg(target.name)}${ns}`;
  }
}

// ── Integrations (K5): fleet overview, cluster alerts, AI explain ────────────

/** Alert types raised for clusters (spec §13.4: opt-in per org, `clusterAlerts`). */
export type KubeClusterAlertType =
  | 'kube_cluster_unreachable'
  | 'kube_node_not_ready'
  | 'kube_workload_unavailable'
  | 'kube_pod_crashloop'
  | 'kube_pod_pending';

/** An open cluster alert, as the fleet overview shows it. */
export interface KubeClusterAlert {
  type: KubeClusterAlertType;
  severity: AlertSeverity;
  /** What it is about: `Node worker-1`, `shop/Deployment web`, or the cluster itself. */
  object: string;
  message: string;
  openedAt: string;
}

/** One thing wrong on a cluster, linked to its object (the fleet overview's short list). */
export interface KubeFleetProblem {
  ref: KubeObjectRef;
  severity: AlertSeverity;
  /** CrashLoopBackOff, NotReady, Unschedulable, "0 of 3 ready"… */
  reason: string;
}

/** One cluster on the fleet overview: health in numbers, or why it could not be read. */
export interface KubeFleetCluster {
  clusterId: string;
  name: string;
  ok: boolean;
  /** Why the cluster could not be read in time (only when `ok` is false). */
  error?: string;
  code?: string;
  durationMs: number;
  serverVersion: string | null;
  nodes: { total: number; ready: number; cordoned: number };
  /** Pods by tile colour (spec §5.1). */
  pods: Record<KubePodTileStatus, number>;
  /** Deployments, StatefulSets and DaemonSets by health. */
  workloads: Partial<Record<KubeWorkloadHealth, number>>;
  /** The worst few problems, most severe first. */
  problems: KubeFleetProblem[];
  /** Open cluster alerts (when the org has them on). */
  alerts: KubeClusterAlert[];
  /** What this credential could not list, in plain words. */
  warnings: string[];
}

/** GET /api/kube/overview — every cluster the caller may use, read a few at a time; partial results. */
export interface KubeFleetOverview {
  clusters: KubeFleetCluster[];
  /** The org's `clusterAlerts` setting. */
  alertsEnabled: boolean;
  generatedAt: string;
}

/** Body of `POST /api/kube/clusters/:id/explain`. */
export interface KubeExplainRequest {
  resource: KubeResource;
  /** null (or omitted) for cluster-scoped objects. */
  namespace?: string | null;
  name: string;
  /** An AI provider of the org; the default one when omitted. */
  providerId?: string;
}

/** What an explanation was given, so the person sees what left for the AI provider (never a Secret value). */
export interface KubeExplainContext {
  ref: KubeObjectRef;
  /** Events about the object (and its pods) included. */
  events: number;
  /** Log lines included (operators and up, pods only); 0 when none. */
  logLines: number;
  /** Pods of a workload whose status was included. */
  pods: number;
  /** The AI provider's name. */
  provider: string;
}

/** Events on the explain stream. */
export type KubeExplainEvent =
  | { type: 'context'; context: KubeExplainContext }
  | { type: 'delta'; content: string }
  | { type: 'done' }
  | { type: 'error'; error: string; status?: number };
