import { BaseEdge, EdgeLabelRenderer, Handle, Position, getBezierPath, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import type { KubeGraphEdge, KubeGraphNode, KubePodTile, KubePodTileStatus } from '@smt/shared';
import {
  Box,
  CircleDot,
  Clock,
  Copy,
  Database,
  FileText,
  Gauge,
  Globe,
  HardDrive,
  KeyRound,
  Layers,
  Play,
  Server,
  TriangleAlert,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { GRAPH_HEALTH_STYLE, TILE_LABEL, TILE_STYLE } from '@/lib/kube.js';

/**
 * The topology graph's pieces for React Flow: an object node (kind, name,
 * one-line summary, coloured by health, a red badge counting its problems),
 * a replica ring (a donut of its pods' colours with ready/desired; expanded,
 * the pods as tiles) and an edge (dashed red when it leads nowhere, its
 * explanation on hover). Sizes are fixed so the ELK layout matches what is
 * drawn.
 */

export const NODE_WIDTH = 230;
export const NODE_HEIGHT = 64;
export const RING_HEIGHT = 84;
const TILE = 14;
const TILE_GAP = 3;
const TILES_PER_ROW = 14;
export const EXPANDED_WIDTH = TILES_PER_ROW * (TILE + TILE_GAP) + 24;
/** Rows shown before the tile grid scrolls. */
const MAX_ROWS = 16;

/** Size of a replica ring, expanded or not. */
export function ringSize(pods: number, expanded: boolean): { width: number; height: number } {
  if (!expanded) return { width: NODE_WIDTH, height: RING_HEIGHT };
  const rows = Math.min(MAX_ROWS, Math.max(1, Math.ceil(pods / TILES_PER_ROW)));
  return { width: EXPANDED_WIDTH, height: RING_HEIGHT + rows * (TILE + TILE_GAP) + 8 };
}

const KIND_ICON: Record<string, LucideIcon> = {
  Ingress: Globe,
  Service: Waypoints,
  Deployment: Layers,
  StatefulSet: Database,
  DaemonSet: Server,
  CronJob: Clock,
  Job: Play,
  ReplicaSet: Copy,
  Pod: Box,
  Pods: CircleDot,
  ConfigMap: FileText,
  Secret: KeyRound,
  PersistentVolumeClaim: HardDrive,
  PersistentVolume: HardDrive,
  HorizontalPodAutoscaler: Gauge,
};

const KIND_LABEL: Record<string, string> = {
  PersistentVolumeClaim: 'Volume claim',
  PersistentVolume: 'Volume',
  HorizontalPodAutoscaler: 'Autoscaler',
};

export type ObjectNodeData = { node: KubeGraphNode };
export type RingNodeData = { node: KubeGraphNode; expanded: boolean; onOpenPod: (pod: KubePodTile) => void };
export type ObjectFlowNode = Node<ObjectNodeData, 'object'>;
export type RingFlowNode = Node<RingNodeData, 'ring'>;
export type KubeFlowEdge = Edge<{ edge: KubeGraphEdge }, 'kube'>;

const hidden = '!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent';

function Badge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span
      className="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-semibold text-white shadow"
      title={`${count} problem${count === 1 ? '' : 's'}`}
      data-testid="graph-problems"
    >
      {count}
    </span>
  );
}

export function ObjectNode({ data }: NodeProps<ObjectFlowNode>) {
  const n = data.node;
  const style = GRAPH_HEALTH_STYLE[n.health];
  const Icon = KIND_ICON[n.kind] ?? (n.health === 'missing' ? TriangleAlert : Box);
  return (
    <div
      data-testid="graph-node"
      data-id={n.id}
      data-kind={n.kind}
      data-health={n.health}
      title={`${n.kind} ${n.namespace ? `${n.namespace}/` : ''}${n.name} — ${style.label}`}
      className={cn(
        'relative flex items-center gap-2.5 rounded-lg border-2 bg-card px-3 shadow-sm',
        style.border,
        n.health === 'failing' && 'bg-red-50 dark:bg-red-950/40',
        n.health === 'missing' && 'bg-red-50/60 dark:bg-red-950/20',
        n.ref && 'cursor-pointer hover:shadow-md',
      )}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
      <Icon size={18} className={cn('shrink-0', n.health === 'missing' ? 'text-red-500' : 'text-muted-foreground')} />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', style.dot)} />
          {n.health === 'missing'
            ? n.kind === 'Pods'
              ? 'Pods · none match'
              : `${KIND_LABEL[n.kind] ?? n.kind} · missing`
            : (KIND_LABEL[n.kind] ?? n.kind)}
        </p>
        <p className="truncate text-sm font-semibold">{n.name}</p>
        <p className="truncate text-xs text-muted-foreground">{n.summary}</p>
      </div>
      <Badge count={n.problems} />
      <Handle type="source" position={Position.Right} isConnectable={false} className={hidden} />
    </div>
  );
}

const RING_COLOUR: Record<KubePodTileStatus, string> = {
  running: '#10b981',
  pending: '#fbbf24',
  failing: '#ef4444',
  completed: '#a1a1aa',
  terminating: '#8b5cf6',
};
const RING_ORDER: KubePodTileStatus[] = ['running', 'pending', 'failing', 'terminating', 'completed'];

/** A donut of the pods' colours; segments animate as replicas come and go. */
function Donut({ counts, total }: { counts: Record<KubePodTileStatus, number>; total: number }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={48} height={48} viewBox="0 0 48 48" className="shrink-0 -rotate-90" aria-hidden>
      <circle cx={24} cy={24} r={r} fill="none" strokeWidth={7} className="stroke-muted" />
      {RING_ORDER.map((status) => {
        const n = counts[status];
        if (!n || !total) return null;
        const len = (n / total) * c;
        const seg = (
          <circle
            key={status}
            cx={24}
            cy={24}
            r={r}
            fill="none"
            stroke={RING_COLOUR[status]}
            strokeWidth={7}
            strokeDasharray={`${len} ${c - len}`}
            strokeDashoffset={-offset}
            style={{ transition: 'stroke-dasharray 400ms ease, stroke-dashoffset 400ms ease' }}
          />
        );
        offset += len;
        return seg;
      })}
    </svg>
  );
}

export function RingNode({ data }: NodeProps<RingFlowNode>) {
  const n = data.node;
  const g = n.pods!;
  const style = GRAPH_HEALTH_STYLE[n.health];
  const size = ringSize(g.total, data.expanded);
  const parts = RING_ORDER.filter((s) => g.counts[s]).map((s) => `${g.counts[s]} ${TILE_LABEL[s].toLowerCase()}`);
  return (
    <div
      data-testid="graph-ring"
      data-id={n.id}
      data-health={n.health}
      data-expanded={data.expanded}
      className={cn('relative cursor-pointer rounded-2xl border-2 bg-card px-3 py-2 shadow-sm hover:shadow-md', style.border)}
      style={size}
      title={data.expanded ? 'Click to collapse' : `${parts.join(', ')} — click to show each pod`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
      <div className="flex items-center gap-2.5" style={{ height: RING_HEIGHT - 20 }}>
        <div className="relative">
          <Donut counts={g.counts} total={g.total} />
          <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums">
            {g.ready}/{g.desired ?? g.total}
          </span>
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {g.total} pod{g.total === 1 ? '' : 's'}
          </p>
          <p className="truncate text-sm font-semibold">{n.name}</p>
          <p className="truncate text-xs text-muted-foreground" data-testid="ring-summary">
            {parts.join(' · ')}
          </p>
        </div>
      </div>
      {data.expanded && (
        <div className="nowheel flex max-h-[18rem] flex-wrap content-start gap-[3px] overflow-y-auto" data-testid="ring-pods">
          {g.pods.map((p) => (
            <button
              key={`${p.namespace}/${p.name}`}
              type="button"
              data-testid="ring-pod"
              data-status={p.status}
              title={`${p.name}: ${TILE_LABEL[p.status]}${p.reason ? ` (${p.reason})` : ''}${p.restarts ? `, ${p.restarts} restarts` : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                data.onOpenPod(p);
              }}
              className={cn('nodrag rounded-[3px] border hover:scale-125', TILE_STYLE[p.status])}
              style={{ width: TILE, height: TILE }}
            />
          ))}
          {g.total > g.pods.length && <span className="text-xs text-muted-foreground">+{g.total - g.pods.length} more</span>}
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} className={hidden} />
    </div>
  );
}

const SIDE_LINKS = new Set(['mounts', 'env', 'bound', 'scales']);

export function KubeEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<KubeFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const e = data!.edge;
  const side = SIDE_LINKS.has(e.relation);
  return (
    <g data-testid="graph-edge" data-broken={e.broken} data-relation={e.relation} data-source={e.source} data-target={e.target}>
      <title>{e.explanation}</title>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={16}
        style={{
          stroke: e.broken ? '#ef4444' : side ? 'var(--graph-side-edge, #cbd5e1)' : 'var(--graph-edge, #94a3b8)',
          strokeWidth: e.broken ? 2.25 : side ? 1.25 : 1.75,
          strokeDasharray: e.broken ? '6 4' : undefined,
        }}
      />
      {e.broken && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute flex size-5 items-center justify-center rounded-full bg-red-500 text-[11px] font-bold text-white shadow"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={e.explanation}
          >
            !
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}
