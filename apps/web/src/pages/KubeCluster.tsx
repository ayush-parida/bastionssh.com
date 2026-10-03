import { useCallback } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { KubeNamespace } from '@smt/shared';
import { ChevronLeft, Layers } from 'lucide-react';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import {
  CLUSTER_DOT,
  CLUSTER_STATUS_LABEL,
  KUBE_TABS,
  isKubeTab,
  kubeKeys,
  kubePath,
  kubeTabUrl,
  useKubeChanges,
  useKubeCluster,
  useKubeNamespace,
  type KubeObjectLinkState,
  type KubeTab,
} from '@/lib/kube.js';
import { DiagnoseButton } from '@/components/diagnostics/Diagnostics.js';
import ObjectPanel, { refFromParams } from '@/components/kube/ObjectPanel.js';
import MapTab from '@/components/kube/MapTab.js';
import AppsTab from '@/components/kube/AppsTab.js';
import WorkloadsTab from '@/components/kube/WorkloadsTab.js';
import EventsTab from '@/components/kube/EventsTab.js';
import NodesTab from '@/components/kube/NodesTab.js';
import StorageTab from '@/components/kube/StorageTab.js';
import ConfigTab from '@/components/kube/ConfigTab.js';

/** Each tab's body; every one lives in its own file so a phase can replace it alone. */
const TAB_BODY: Record<KubeTab, React.ComponentType<{ clusterId: string; namespace: string }>> = {
  map: MapTab,
  apps: AppsTab,
  workloads: WorkloadsTab,
  events: EventsTab,
  nodes: NodesTab,
  storage: StorageTab,
  config: ConfigTab,
};

/** Namespaces to pick from, kept current as namespaces come and go. */
function NamespacePicker({ clusterId, value, onChange }: { clusterId: string; value: string; onChange: (ns: string) => void }) {
  const namespaces = useQuery<KubeNamespace[]>({
    queryKey: kubeKeys.namespaces(clusterId),
    queryFn: () => api.get(kubePath(clusterId, '/namespaces')),
    retry: false,
  });
  useKubeChanges(clusterId, 'namespaces', {}, kubeKeys.namespaces(clusterId), namespaces.isSuccess);
  const names = namespaces.data?.map((n) => n.name) ?? [];
  // A remembered namespace that is gone (or no longer allowed) still shows, so the filter is never silent
  if (value && namespaces.data && !names.includes(value)) names.unshift(value);
  return (
    <label className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5 text-sm">
      <Layers size={14} className="shrink-0 text-muted-foreground" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-[8rem] bg-transparent focus:outline-none"
        title="Namespace"
        data-testid="namespace-picker"
      >
        <option value="">All namespaces</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * One cluster (spec §5.5): Map · Apps · Workloads · Events · Nodes · Storage
 * · Config, with a namespace picker remembered per user. An object's URL
 * (`…/objects/<resource>/<namespace>/<name>`) opens its panel over the tab it
 * was opened from — or over the map, for a shared link.
 */
export default function KubeClusterPage() {
  const params = useParams<{ clusterId: string; tab?: string; resource?: string; ns?: string; name?: string }>();
  const clusterId = params.clusterId!;
  const location = useLocation();
  const navigate = useNavigate();
  const [namespace, setNamespace] = useKubeNamespace(clusterId);
  const status = useKubeCluster(clusterId);

  const objectRef = params.resource && params.ns && params.name ? refFromParams(params.resource, params.ns, params.name) : null;
  const linkState = location.state as KubeObjectLinkState | null;
  const tab: KubeTab = objectRef ? (isKubeTab(linkState?.tab) ? linkState.tab : 'map') : isKubeTab(params.tab) ? params.tab : 'map';
  const closePanel = useCallback(() => navigate(kubeTabUrl(clusterId, tab)), [navigate, clusterId, tab]);

  if (!objectRef && params.tab && !isKubeTab(params.tab)) return <Navigate to={kubeTabUrl(clusterId)} replace />;

  if (status.error) {
    return (
      <div className="p-6">
        <Link to="/kubernetes" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft size={14} /> Clusters
        </Link>
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(status.error as Error).message}</p>
      </div>
    );
  }
  const cluster = status.data?.cluster;
  const Body = TAB_BODY[tab];

  return (
    <div className="p-6">
      <Link to="/kubernetes" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft size={14} /> Clusters
      </Link>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            {cluster && (
              <span className={cn('size-2.5 shrink-0 rounded-full', CLUSTER_DOT[cluster.lastStatus])} title={CLUSTER_STATUS_LABEL[cluster.lastStatus]} />
            )}
            <span className="truncate">{cluster?.name ?? '…'}</span>
          </h1>
          {cluster && (
            <p className="truncate text-sm text-muted-foreground">
              {cluster.serverVersion ? `Kubernetes ${cluster.serverVersion} · ` : ''}
              <span className="font-mono text-xs">{cluster.apiUrl}</span>
              {cluster.connectVia !== 'direct' && ` · through ${cluster.viaServerName ?? cluster.viaAgentName ?? cluster.connectVia}`}
            </p>
          )}
        </div>
        {cluster && <DiagnoseButton target={{ kind: 'kube_cluster', id: cluster.id, name: cluster.name }} />}
        <NamespacePicker clusterId={clusterId} value={namespace} onChange={setNamespace} />
      </div>

      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-border" aria-label="Cluster views">
        {KUBE_TABS.map((t) => (
          <Link
            key={t.id}
            to={kubeTabUrl(clusterId, t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm',
              tab === t.id ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {status.data && <Body clusterId={clusterId} namespace={namespace} />}

      {objectRef && <ObjectPanel clusterId={clusterId} objectRef={objectRef} fromTab={tab} onClose={closePanel} />}
    </div>
  );
}
