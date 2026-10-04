import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { KubeFleetCluster, KubeFleetOverview, KubePodTileStatus, KubeWorkloadHealth } from '@smt/shared';
import { kubeObjectUrl } from '@smt/shared';
import { AlertTriangle, BellOff, BellRing, ChevronLeft, LayoutGrid, Radar, RefreshCw, ServerCrash } from 'lucide-react';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { HEALTH_DOT, HEALTH_LABEL, TILE_LABEL, TILE_STYLE, kubeTabUrl } from '@/lib/kube.js';
import { useModule } from '@/hooks/useModules.js';

const fleetKey = ['kube', 'fleet'] as const;

const POD_ORDER: KubePodTileStatus[] = ['failing', 'pending', 'terminating', 'running', 'completed'];
const WORKLOAD_ORDER: KubeWorkloadHealth[] = ['failed', 'degraded', 'progressing', 'healthy', 'suspended', 'idle', 'completed'];
/** Node squares drawn one by one up to this many; larger clusters get a bar. */
const MAX_NODE_SQUARES = 48;

/** A cluster's colour in a word: red when something critical is wrong, amber for warnings, green otherwise. */
function clusterTone(c: KubeFleetCluster): 'ok' | 'warn' | 'bad' | 'down' {
  if (!c.ok) return 'down';
  if (c.alerts.some((a) => a.severity === 'critical') || c.problems.some((p) => p.severity === 'critical')) return 'bad';
  if (c.alerts.length || c.problems.length) return 'warn';
  return 'ok';
}

const TONE_DOT = { ok: 'bg-emerald-500', warn: 'bg-amber-400', bad: 'bg-red-500', down: 'bg-zinc-400' } as const;
const TONE_LABEL = { ok: 'Healthy', warn: 'Needs a look', bad: 'Something is failing', down: 'Could not be read' } as const;

/** Nodes as squares: green ready, red not ready, a ring when cordoned. */
function NodeSquares({ nodes }: { nodes: KubeFleetCluster['nodes'] }) {
  if (!nodes.total) return <p className="text-xs text-muted-foreground">Nodes not visible to this credential</p>;
  if (nodes.total > MAX_NODE_SQUARES) {
    return (
      <div className="flex h-2.5 w-full overflow-hidden rounded-sm bg-muted" title={`${nodes.ready} of ${nodes.total} nodes ready`}>
        <div className="bg-emerald-500" style={{ width: `${(nodes.ready / nodes.total) * 100}%` }} />
        <div className="flex-1 bg-red-500" />
      </div>
    );
  }
  const notReady = nodes.total - nodes.ready;
  return (
    <div className="flex flex-wrap gap-1" aria-label={`${nodes.ready} of ${nodes.total} nodes ready`} data-testid="fleet-nodes">
      {Array.from({ length: nodes.total }, (_, i) => (
        <span
          key={i}
          className={cn('size-3 rounded-sm', i < notReady ? 'bg-red-500' : 'bg-emerald-500', i >= nodes.total - nodes.cordoned && 'ring-2 ring-zinc-400 ring-offset-1 ring-offset-card')}
          title={i < notReady ? 'Not ready' : 'Ready'}
        />
      ))}
    </div>
  );
}

/** Pods as one stacked bar in the cluster map's tile colours. */
function PodBar({ pods }: { pods: KubeFleetCluster['pods'] }) {
  const total = POD_ORDER.reduce((n, s) => n + pods[s], 0);
  if (!total) return <p className="text-xs text-muted-foreground">No pods</p>;
  return (
    <div className="space-y-1.5">
      <div className="flex h-3 w-full overflow-hidden rounded-sm bg-muted" data-testid="fleet-pods">
        {POD_ORDER.filter((s) => pods[s]).map((s) => (
          <div
            key={s}
            className={cn('h-full border-r border-card last:border-r-0', TILE_STYLE[s])}
            style={{ width: `${(pods[s] / total) * 100}%` }}
            title={`${pods[s]} ${TILE_LABEL[s].toLowerCase()}`}
          />
        ))}
      </div>
      <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        {POD_ORDER.filter((s) => pods[s]).map((s) => (
          <span key={s} className={cn((s === 'failing' || s === 'pending') && 'font-medium text-foreground')}>
            {pods[s]} {TILE_LABEL[s].toLowerCase()}
          </span>
        ))}
      </p>
    </div>
  );
}

function ClusterCard({ c }: { c: KubeFleetCluster }) {
  const tone = clusterTone(c);
  const workloads = WORKLOAD_ORDER.filter((h) => c.workloads[h]);
  return (
    <div className="flex flex-col rounded-lg border border-border bg-card" data-testid="fleet-cluster">
      <Link to={kubeTabUrl(c.clusterId)} className="flex items-center gap-2 border-b border-border px-4 py-3 hover:bg-muted/30">
        <span className={cn('size-2.5 shrink-0 rounded-full', TONE_DOT[tone])} title={TONE_LABEL[tone]} />
        <span className="truncate font-semibold">{c.name}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{c.serverVersion ?? ''}</span>
      </Link>

      {!c.ok ? (
        <div className="flex flex-1 items-start gap-2 p-4 text-sm">
          <ServerCrash size={15} className="mt-0.5 shrink-0 text-amber-500" />
          <p className="min-w-0 break-words text-muted-foreground">{c.error}</p>
        </div>
      ) : (
        <div className="flex-1 space-y-4 p-4">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              Nodes · {c.nodes.ready} of {c.nodes.total} ready{c.nodes.cordoned ? ` · ${c.nodes.cordoned} cordoned` : ''}
            </p>
            <NodeSquares nodes={c.nodes} />
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Pods</p>
            <PodBar pods={c.pods} />
          </div>
          {workloads.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Workloads</p>
              <div className="flex flex-wrap gap-1.5">
                {workloads.map((h) => (
                  <span key={h} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs">
                    <span className={cn('size-2 rounded-full', HEALTH_DOT[h])} />
                    {c.workloads[h]} {HEALTH_LABEL[h].toLowerCase()}
                  </span>
                ))}
              </div>
            </div>
          )}
          {c.problems.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Needs attention</p>
              <ul className="space-y-1" data-testid="fleet-problems">
                {c.problems.map((p) => (
                  <li key={`${p.ref.resource}/${p.ref.namespace}/${p.ref.name}`}>
                    <Link to={kubeObjectUrl(c.clusterId, p.ref)} className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted">
                      <span className={cn('size-2 shrink-0 rounded-full', p.severity === 'critical' ? 'bg-red-500' : 'bg-amber-400')} />
                      <span className="shrink-0 text-muted-foreground">{p.ref.kind}</span>
                      <span className="truncate font-medium">
                        {p.ref.namespace ? `${p.ref.namespace}/` : ''}
                        {p.ref.name}
                      </span>
                      <span className="ml-auto shrink-0 truncate text-muted-foreground">{p.reason}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {c.warnings.map((w) => (
            <p key={w} className="text-xs text-amber-600">
              {w}
            </p>
          ))}
        </div>
      )}

      {c.alerts.length > 0 && (
        <div className="space-y-1 border-t border-border px-4 py-3" data-testid="fleet-alerts">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <BellRing size={12} className="text-red-500" />
            {c.alerts.length} open alert{c.alerts.length === 1 ? '' : 's'}
          </p>
          {c.alerts.slice(0, 4).map((a) => (
            <p key={`${a.type}/${a.object}`} className={cn('truncate text-xs', a.severity === 'critical' ? 'text-red-600' : 'text-amber-600')} title={a.message}>
              {a.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Every cluster at a glance (spec §4.2 fleet overview, K5): nodes as
 * squares, pods as a bar in the map's colours, workloads by health, the
 * worst problems (each a link to its object) and open cluster alerts. The
 * server reads a few clusters at a time with a deadline each, so one
 * unreachable cluster is a grey card, never an empty page.
 */
export default function KubeOverviewPage() {
  const isAdmin = useModule('kubernetes', 'manage');
  const fleet = useQuery<KubeFleetOverview>({
    queryKey: fleetKey,
    queryFn: () => api.get('/kube/overview'),
    refetchInterval: 30_000,
  });
  const clusters = fleet.data?.clusters ?? [];
  const read = clusters.filter((c) => c.ok);
  const sum = (f: (c: KubeFleetCluster) => number) => read.reduce((n, c) => n + f(c), 0);
  const tiles = [
    { label: 'Clusters answering', value: `${read.length} / ${clusters.length}`, warn: read.length < clusters.length },
    { label: 'Nodes ready', value: `${sum((c) => c.nodes.ready)} / ${sum((c) => c.nodes.total)}`, warn: sum((c) => c.nodes.total - c.nodes.ready) > 0 },
    { label: 'Pods failing', value: String(sum((c) => c.pods.failing)), warn: sum((c) => c.pods.failing) > 0 },
    { label: 'Open alerts', value: fleet.data?.alertsEnabled ? String(clusters.reduce((n, c) => n + c.alerts.length, 0)) : 'off', warn: clusters.some((c) => c.alerts.length) },
  ];
  // Worst first: what needs a look leads
  const order = { down: 1, bad: 0, warn: 2, ok: 3 } as const;
  const sorted = [...clusters].sort((a, b) => order[clusterTone(a)] - order[clusterTone(b)] || a.name.localeCompare(b.name));

  return (
    <div className="p-6">
      <Link to="/kubernetes" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft size={14} /> Clusters
      </Link>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <LayoutGrid size={22} className="text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Kubernetes overview</h1>
            <p className="text-sm text-muted-foreground">Every cluster you can access, and what needs attention</p>
          </div>
        </div>
        <button
          onClick={() => fleet.refetch()}
          disabled={fleet.isFetching}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw size={14} className={cn(fleet.isFetching && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {fleet.isLoading ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          <Radar size={15} className="animate-pulse" /> Asking your clusters…
        </div>
      ) : fleet.error ? (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(fleet.error as Error).message}</p>
      ) : clusters.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">No clusters you can access yet.</p>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            {tiles.map((t) => (
              <div key={t.label} className="rounded-lg border border-border bg-card p-4">
                <p className={cn('text-2xl font-bold leading-tight', t.warn && 'text-red-600')}>{t.value}</p>
                <p className="text-xs text-muted-foreground">{t.label}</p>
              </div>
            ))}
          </div>

          {!fleet.data?.alertsEnabled && (
            <p className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
              <BellOff size={13} />
              Cluster alerts are off{isAdmin ? ' — turn them on under Settings → Kubernetes to be told about failing nodes, workloads and pods.' : '.'}
            </p>
          )}
          {clusters.some((c) => !c.ok) && (
            <p className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
              <AlertTriangle size={13} className="text-amber-500" />
              Clusters that did not answer within a few seconds are shown in grey; open one for details.
            </p>
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sorted.map((c) => (
              <ClusterCard key={c.clusterId} c={c} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
