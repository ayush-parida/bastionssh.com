import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { KubeGraph, KubeGraphHealth, KubeGraphNode, KubePodTile } from '@smt/shared';
import { kubeObjectUrl } from '@smt/shared';
import { Unlink } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { GRAPH_HEALTH_STYLE, type KubeObjectLinkState } from '@/lib/kube.js';
import { Ticks } from './DiagnosisCard.js';
import {
  KubeEdge,
  NODE_HEIGHT,
  NODE_WIDTH,
  ObjectNode,
  RingNode,
  ringSize,
  type KubeFlowEdge,
  type ObjectFlowNode,
  type RingFlowNode,
} from './TopologyGraphNodes.js';

/**
 * The app topology graph (spec §5.2), drawn with React Flow and laid out
 * left to right by ELK's layered algorithm: Ingress → Service → workload →
 * pods, config and storage beside. Node colour is health, a red badge counts
 * problems, dashed red edges lead nowhere (the reason on hover, and listed
 * under the graph). A workload's pods are one replica ring; click it to see
 * each pod, click a pod or an object to open its panel. Large namespaces can
 * be narrowed to one app (a connected part of the graph).
 *
 * The layout only reruns when the set of nodes or expanded rings changes, so
 * live updates recolour in place instead of shuffling the picture.
 */

const elk = new ELK();

const nodeTypes = { object: ObjectNode, ring: RingNode };
const edgeTypes = { kube: KubeEdge };

const MINIMAP_COLOUR: Record<KubeGraphHealth, string> = {
  healthy: '#10b981',
  progressing: '#0ea5e9',
  warning: '#f59e0b',
  failing: '#ef4444',
  idle: '#a1a1aa',
  missing: '#ef4444',
};

/** Kinds that name an app, best first: a part of the graph is called after its first such node. */
const APP_NAMERS = ['Ingress', 'Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Service', 'Job'];

/** Connected parts of the graph ("apps"), largest first, each named after its most telling node. */
export function graphApps(graph: KubeGraph): { id: string; label: string; nodeIds: Set<string> }[] {
  const parent = new Map(graph.nodes.map((n) => [n.id, n.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (const e of graph.edges) {
    if (parent.has(e.source) && parent.has(e.target)) parent.set(find(e.source), find(e.target));
  }
  const groups = new Map<string, KubeGraphNode[]>();
  for (const n of graph.nodes) groups.set(find(n.id), [...(groups.get(find(n.id)) ?? []), n]);
  return [...groups.values()]
    .map((nodes) => {
      const namer = APP_NAMERS.map((k) => nodes.find((n) => n.kind === k)).find(Boolean) ?? nodes[0]!;
      return { id: namer.id, label: `${namer.namespace ? `${namer.namespace}/` : ''}${namer.name}`, nodeIds: new Set(nodes.map((n) => n.id)) };
    })
    .sort((a, b) => b.nodeIds.size - a.nodeIds.size || a.label.localeCompare(b.label));
}

function sizeOf(n: KubeGraphNode, expanded: boolean) {
  return n.pods ? ringSize(n.pods.total, expanded) : { width: NODE_WIDTH, height: NODE_HEIGHT };
}

function Graph({ clusterId, graph }: { clusterId: string; graph: KubeGraph }) {
  const navigate = useNavigate();
  const flow = useReactFlow();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [app, setApp] = useState('');
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }> | null>(null);

  const apps = useMemo(() => graphApps(graph), [graph]);
  const picked = apps.find((a) => a.id === app) ?? null;
  const nodes = useMemo(() => (picked ? graph.nodes.filter((n) => picked.nodeIds.has(n.id)) : graph.nodes), [graph, picked]);
  const edges = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    return graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  }, [graph, nodes]);

  // Lay out again only when the shape changes
  const shape = useMemo(
    () =>
      JSON.stringify({
        n: nodes.map((n) => `${n.id}:${n.pods && expanded.has(n.id) ? ringSize(n.pods.total, true).height : ''}`),
        e: edges.map((e) => e.id),
      }),
    [nodes, edges, expanded],
  );
  useEffect(() => {
    let cancelled = false;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    void elk
      .layout({
        id: 'root',
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'RIGHT',
          'elk.layered.spacing.nodeNodeBetweenLayers': '80',
          'elk.spacing.nodeNode': '28',
          'elk.spacing.componentComponent': '48',
          'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
        },
        children: nodes.map((n) => ({ id: n.id, ...sizeOf(n, expanded.has(n.id)) })),
        edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
      })
      .then((laid) => {
        if (cancelled) return;
        setPositions(new Map((laid.children ?? []).filter((c) => byId.has(c.id)).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }])));
      })
      .catch(() => {
        // A layout failure must not blank the page: fall back to a grid
        if (!cancelled) setPositions(new Map(nodes.map((n, i) => [n.id, { x: (i % 5) * (NODE_WIDTH + 60), y: Math.floor(i / 5) * 120 }])));
      });
    return () => {
      cancelled = true;
    };
    // `shape` stands for nodes, edges and expanded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  useEffect(() => {
    if (positions) requestAnimationFrame(() => void flow.fitView({ padding: 0.15, duration: 200, maxZoom: 1.2 }));
  }, [positions, flow]);

  const openPod = useCallback(
    (pod: KubePodTile) =>
      navigate(kubeObjectUrl(clusterId, { resource: 'pods', namespace: pod.namespace, name: pod.name }), {
        state: { tab: 'apps' } satisfies KubeObjectLinkState,
      }),
    [navigate, clusterId],
  );

  const rfNodes = useMemo<(ObjectFlowNode | RingFlowNode)[]>(
    () =>
      positions
        ? nodes.map((n) =>
            n.pods
              ? ({
                  id: n.id,
                  type: 'ring',
                  position: positions.get(n.id) ?? { x: 0, y: 0 },
                  data: { node: n, expanded: expanded.has(n.id), onOpenPod: openPod },
                  ...sizeOf(n, expanded.has(n.id)),
                } satisfies RingFlowNode)
              : ({ id: n.id, type: 'object', position: positions.get(n.id) ?? { x: 0, y: 0 }, data: { node: n }, ...sizeOf(n, false) } satisfies ObjectFlowNode),
          )
        : [],
    [nodes, positions, expanded, openPod],
  );
  const rfEdges = useMemo<KubeFlowEdge[]>(
    () => edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: 'kube', data: { edge: e }, zIndex: e.broken ? 1 : 0 })),
    [edges],
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const n = (node.data as { node: KubeGraphNode }).node;
      if (n.pods) {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(n.id)) next.delete(n.id);
          else next.add(n.id);
          return next;
        });
      } else if (n.ref) {
        navigate(kubeObjectUrl(clusterId, n.ref), { state: { tab: 'apps' } satisfies KubeObjectLinkState });
      }
    },
    [navigate, clusterId],
  );

  const broken = edges.filter((e) => e.broken);
  const label = (id: string) => {
    const n = graph.nodes.find((x) => x.id === id);
    return n ? `${n.kind === 'Pods' ? '' : `${n.kind} `}${n.name}` : id;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {apps.length > 1 && (
          <select
            value={app}
            onChange={(e) => setApp(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
            data-testid="graph-app-picker"
            title="Show one app"
          >
            <option value="">All apps ({apps.length})</option>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} ({a.nodeIds.size})
              </option>
            ))}
          </select>
        )}
        <span data-testid="graph-counts">
          {nodes.length} objects · {edges.length} links{broken.length ? ` · ${broken.length} broken` : ''}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-3">
          {(['healthy', 'progressing', 'warning', 'failing', 'idle'] as KubeGraphHealth[]).map((h) => (
            <span key={h} className="flex items-center gap-1">
              <span className={cn('size-2.5 rounded-full', GRAPH_HEALTH_STYLE[h].dot)} />
              {GRAPH_HEALTH_STYLE[h].label}
            </span>
          ))}
          <span className="flex items-center gap-1">
            <svg width="22" height="6" aria-hidden>
              <line x1="0" y1="3" x2="22" y2="3" stroke="#ef4444" strokeWidth="2" strokeDasharray="5 3" />
            </svg>
            Leads nowhere
          </span>
        </span>
      </div>

      <div className="h-[70vh] min-h-[420px] overflow-hidden rounded-lg border border-border bg-card" data-testid="topology-graph">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          nodesConnectable={false}
          edgesFocusable={false}
          minZoom={0.1}
          maxZoom={2}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
          {nodes.length > 30 && (
            <MiniMap pannable zoomable nodeColor={(n) => MINIMAP_COLOUR[(n.data as { node: KubeGraphNode }).node.health]} />
          )}
        </ReactFlow>
      </div>

      {broken.length > 0 && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-3" data-testid="broken-links">
          <p className="mb-1.5 flex items-center gap-2 text-sm font-medium">
            <Unlink size={14} className="text-red-500" /> {broken.length} link{broken.length === 1 ? '' : 's'} lead nowhere
          </p>
          <ul className="space-y-1 text-sm">
            {broken.map((e) => (
              <li key={e.id}>
                <span className="font-medium">{label(e.source)}</span> → <span className="font-medium">{label(e.target)}</span>:{' '}
                <span className="text-muted-foreground">
                  <Ticks text={e.explanation} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function TopologyGraph(props: { clusterId: string; graph: KubeGraph }) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}
