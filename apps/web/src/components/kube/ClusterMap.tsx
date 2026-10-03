import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { KubeNodeCard, KubeOverview, KubePodTile, KubePodTileStatus } from '@smt/shared';
import { kubeObjectUrl } from '@smt/shared';
import { AlertTriangle, Ban, Cpu, Hourglass, MemoryStick, Server } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { TILE_LABEL, TILE_STYLE, formatCpu, formatMemory, percent, type KubeObjectLinkState } from '@/lib/kube.js';
import CordonToggle from './actions/CordonToggle.js';

/**
 * The cluster map (spec §5.1): one card per node with its CPU and memory —
 * what pods asked for and, with metrics, what they use — and its pods as
 * small coloured tiles. Hover a tile for the pod's name and state; click it
 * to open the pod. Picking a namespace dims every tile outside it rather than
 * hiding it, so the shape of the cluster stays. Pods no node has taken wait
 * in their own lane, with the scheduler's reason.
 */

const STATUSES: KubePodTileStatus[] = ['running', 'pending', 'failing', 'completed', 'terminating'];

/** What a node condition means for the pods on it. */
const PRESSURE_HINT: Record<string, string> = {
  MemoryPressure: 'The node is running low on memory; Kubernetes may evict pods to free some',
  DiskPressure: 'The node is running low on disk; Kubernetes may evict pods and clean up images',
  PIDPressure: 'The node is running too many processes; Kubernetes may evict pods',
  NetworkUnavailable: 'The node’s network is not set up; its pods cannot be reached',
};

function Bar({
  icon: Icon,
  label,
  requested,
  used,
  total,
  format,
}: {
  icon: typeof Cpu;
  label: string;
  requested: number;
  used: number | null;
  total: number;
  format: (n: number) => string;
}) {
  const req = percent(requested, total);
  const use = used === null ? null : percent(used, total);
  const tone = (p: number) => (p >= 90 ? 'bg-red-500' : p >= 75 ? 'bg-amber-500' : 'bg-sky-500');
  return (
    <div className="space-y-1" title={`${label}: ${format(requested)} requested${used !== null ? `, ${format(used)} in use` : ''} of ${format(total)}`}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1 text-muted-foreground">
          <Icon size={12} /> {label}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {total ? (
            <>
              <span className="text-foreground">{req}%</span> requested{use !== null && <> · <span className="text-foreground">{use}%</span> used</>}
            </>
          ) : (
            'capacity unknown'
          )}
        </span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className={cn('absolute inset-y-0 left-0 rounded-full opacity-60', tone(req))} style={{ width: `${req}%` }} />
        {use !== null && <div className={cn('absolute inset-y-0 left-0 h-1 rounded-full', tone(use))} style={{ width: `${use}%`, top: '25%' }} />}
      </div>
    </div>
  );
}

function Tile({
  tile,
  dimmed,
  onHover,
  onOpen,
}: {
  tile: KubePodTile;
  dimmed: boolean;
  onHover: (tile: KubePodTile | null, el?: HTMLElement) => void;
  onOpen: (tile: KubePodTile) => void;
}) {
  return (
    <button
      type="button"
      data-testid="pod-tile"
      data-status={tile.status}
      aria-label={`${tile.namespace}/${tile.name}: ${TILE_LABEL[tile.status]}${tile.reason ? ` (${tile.reason})` : ''}`}
      onMouseEnter={(e) => onHover(tile, e.currentTarget)}
      onMouseLeave={() => onHover(null)}
      onFocus={(e) => onHover(tile, e.currentTarget)}
      onBlur={() => onHover(null)}
      onClick={() => onOpen(tile)}
      className={cn(
        'size-4 shrink-0 rounded-[3px] border transition-[opacity,transform] hover:scale-125 focus:scale-125 focus:outline-none focus:ring-2 focus:ring-primary',
        TILE_STYLE[tile.status],
        dimmed && 'opacity-15',
        tile.restarts > 0 && tile.status !== 'failing' && 'ring-1 ring-amber-500 ring-offset-1 ring-offset-card',
      )}
    />
  );
}

function NodeCardView({
  card,
  clusterId,
  namespace,
  onHover,
  onOpen,
}: {
  card: KubeNodeCard;
  clusterId: string;
  namespace: string;
  onHover: (tile: KubePodTile | null, el?: HTMLElement) => void;
  onOpen: (tile: KubePodTile) => void;
}) {
  const known = card.allocatable.cpuMillis > 0;
  const live = card.pods.filter((p) => p.status !== 'completed').length;
  return (
    <div
      data-testid="node-card"
      className={cn('flex flex-col gap-3 rounded-lg border bg-card p-4', card.ready ? 'border-border' : 'border-red-500/60')}
    >
      <div className="flex items-start gap-2">
        <Server size={16} className={cn('mt-0.5 shrink-0', card.ready ? 'text-muted-foreground' : 'text-red-500')} />
        <div className="min-w-0 flex-1">
          <Link
            to={kubeObjectUrl(clusterId, { resource: 'nodes', namespace: null, name: card.name })}
            state={{ tab: 'map' } satisfies KubeObjectLinkState}
            className="block truncate text-sm font-semibold hover:underline"
            title={card.name}
          >
            {card.name}
          </Link>
          <div className="mt-1 flex flex-wrap gap-1">
            {card.roles.map((r) => (
              <span key={r} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {r}
              </span>
            ))}
            {!card.ready && (
              <span
                className="rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-600"
                title="Kubernetes has lost contact with this node or it reports a fault; its pods may be moved elsewhere"
              >
                Not ready
              </span>
            )}
            {card.unschedulable && (
              <span
                className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600"
                title="Cordoned: no new pods are placed here; the pods already here keep running"
              >
                <Ban size={10} /> Cordoned
              </span>
            )}
            {card.pressures.map((p) => (
              <span key={p} className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600" title={PRESSURE_HINT[p] ?? undefined}>
                {p.replace('Pressure', ' pressure')}
              </span>
            ))}
          </div>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title="Pods on this node / most it can run">
          {live}
          {card.allocatable.pods ? ` / ${card.allocatable.pods}` : ''} pods
        </span>
        <CordonToggle clusterId={clusterId} node={card.name} unschedulable={card.unschedulable} pods={live} compact />
      </div>
      {known ? (
        <div className="space-y-2">
          <Bar
            icon={Cpu}
            label="CPU"
            requested={card.requested.cpuMillis}
            used={card.usage?.cpuMillis ?? null}
            total={card.allocatable.cpuMillis}
            format={formatCpu}
          />
          <Bar
            icon={MemoryStick}
            label="Memory"
            requested={card.requested.memoryBytes}
            used={card.usage?.memoryBytes ?? null}
            total={card.allocatable.memoryBytes}
            format={formatMemory}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Capacity unknown — this credential may not read nodes.</p>
      )}
      {card.pods.length ? (
        <div className="flex flex-wrap gap-1">
          {card.pods.map((tile) => (
            <Tile
              key={`${tile.namespace}/${tile.name}`}
              tile={tile}
              dimmed={!!namespace && tile.namespace !== namespace}
              onHover={onHover}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No pods.</p>
      )}
    </div>
  );
}

export default function ClusterMap({ clusterId, overview, namespace }: { clusterId: string; overview: KubeOverview; namespace: string }) {
  const navigate = useNavigate();
  const [hover, setHover] = useState<{ tile: KubePodTile; x: number; y: number } | null>(null);

  const counts = useMemo(() => {
    const c: Record<KubePodTileStatus, number> = { running: 0, pending: 0, failing: 0, completed: 0, terminating: 0 };
    for (const tile of [...overview.nodes.flatMap((n) => n.pods), ...overview.unscheduled]) {
      if (!namespace || tile.namespace === namespace) c[tile.status]++;
    }
    return c;
  }, [overview, namespace]);

  const onHover = (tile: KubePodTile | null, el?: HTMLElement) => {
    if (!tile || !el) return setHover(null);
    const rect = el.getBoundingClientRect();
    setHover({ tile, x: rect.left + rect.width / 2, y: rect.bottom + 6 });
  };
  const onOpen = (tile: KubePodTile) =>
    navigate(kubeObjectUrl(clusterId, { resource: 'pods', namespace: tile.namespace, name: tile.name }), {
      state: { tab: 'map' } satisfies KubeObjectLinkState,
    });
  const waiting = overview.unscheduled.filter((t) => !namespace || t.namespace === namespace);

  return (
    <div className="space-y-4">
      {overview.warnings.map((w) => (
        <p key={w} className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {w}
        </p>
      ))}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground" data-testid="map-legend">
        {STATUSES.map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={cn('size-3 rounded-[3px] border', TILE_STYLE[s])} />
            {TILE_LABEL[s]} <span className="tabular-nums text-foreground">{counts[s]}</span>
          </span>
        ))}
        <span className="flex items-center gap-1.5" title="A pod whose containers have restarted at least once">
          <span className="size-3 rounded-[3px] border border-emerald-600 bg-emerald-500 ring-1 ring-amber-500 ring-offset-1 ring-offset-background" />
          Restarted
        </span>
        <span className="flex items-center gap-1.5" title="CPU and memory bars: the wide pale bar is what pods reserved (requests); the thin bar inside is what they use now">
          <span className="relative h-2 w-6 overflow-hidden rounded-full bg-muted">
            <span className="absolute inset-y-0 left-0 w-4 rounded-full bg-sky-500 opacity-60" />
            <span className="absolute left-0 top-1/4 h-1 w-2.5 rounded-full bg-sky-500" />
          </span>
          Reserved / used
        </span>
        <span className="ml-auto">
          {overview.nodes.length} node{overview.nodes.length === 1 ? '' : 's'}
          {!overview.metricsAvailable && ' · live usage needs metrics-server'}
        </span>
      </div>

      {waiting.length > 0 && (
        <div className="rounded-lg border border-dashed border-amber-500/60 bg-amber-500/5 p-4" data-testid="waiting-lane">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Hourglass size={14} className="text-amber-600" /> Waiting for a node
            <span className="text-xs font-normal text-muted-foreground">{waiting.length}</span>
          </p>
          <ul className="space-y-1.5">
            {waiting.map((t) => (
              <li key={`${t.namespace}/${t.name}`} className="flex items-start gap-2 text-sm">
                <Tile tile={t} dimmed={false} onHover={onHover} onOpen={onOpen} />
                <button className="min-w-0 text-left hover:underline" onClick={() => onOpen(t)}>
                  <span className="font-medium">{t.name}</span>
                  <span className="text-muted-foreground"> · {t.namespace}</span>
                  {(t.message ?? t.reason) && <span className="block text-xs text-muted-foreground">{t.message ?? t.reason}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {overview.nodes.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {overview.nodes.map((card) => (
            <NodeCardView key={card.name} card={card} clusterId={clusterId} namespace={namespace} onHover={onHover} onOpen={onOpen} />
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">No nodes to show.</p>
      )}

      {hover && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 max-w-xs -translate-x-1/2 rounded-md border border-border bg-card px-3 py-2 text-xs shadow-lg"
          style={{ left: hover.x, top: hover.y }}
        >
          <p className="font-medium text-foreground">{hover.tile.name}</p>
          <p className="text-muted-foreground">namespace {hover.tile.namespace}</p>
          <p className="mt-1 flex items-center gap-1.5">
            <span className={cn('size-2.5 rounded-[2px] border', TILE_STYLE[hover.tile.status])} />
            {TILE_LABEL[hover.tile.status]}
            {hover.tile.reason && <span className="text-muted-foreground">· {hover.tile.reason}</span>}
          </p>
          <p className="text-muted-foreground">
            {hover.tile.readyContainers}/{hover.tile.totalContainers} ready · {hover.tile.restarts} restart{hover.tile.restarts === 1 ? '' : 's'}
          </p>
          {hover.tile.owner && (
            <p className="text-muted-foreground">
              {hover.tile.owner.kind} {hover.tile.owner.name}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
