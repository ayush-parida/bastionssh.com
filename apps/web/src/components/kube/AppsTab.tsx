import { Suspense, lazy } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { KubeGraph } from '@smt/shared';
import { Network, Radar } from 'lucide-react';
import { api } from '@/lib/api.js';
import { kubeKeys, kubePath, useKubeChanges } from '@/lib/kube.js';

// React Flow and ELK are big; only this tab needs them
const TopologyGraph = lazy(() => import('./TopologyGraph.js'));

function Reading({ what }: { what: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
      <Radar size={15} className="animate-pulse" /> {what}
    </div>
  );
}

/** Apps: the topology graph — Ingress → Service → workload → pods, with config and storage links; live. */
export default function AppsTab({ clusterId, namespace }: { clusterId: string; namespace: string }) {
  const ns = namespace || null;
  const key = kubeKeys.graph(clusterId, ns);
  const graph = useQuery<KubeGraph>({
    queryKey: key,
    queryFn: () => api.get(kubePath(clusterId, `/graph${ns ? `?namespace=${encodeURIComponent(ns)}` : ''}`)),
    retry: false,
  });
  useKubeChanges(clusterId, 'graph', { namespace: ns }, key, graph.isSuccess);

  if (graph.isLoading) return <Reading what="Reading how the apps are wired…" />;
  if (graph.error) return <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(graph.error as Error).message}</p>;
  const g = graph.data;
  if (!g) return null;
  return (
    <div className="space-y-3">
      {g.warnings.map((w) => (
        <p key={w} className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          {w}
        </p>
      ))}
      {!ns && g.nodes.length > 60 && (
        <p className="text-sm text-muted-foreground">Showing every namespace. Pick one above, or one app below, for a smaller picture.</p>
      )}
      {g.nodes.length ? (
        <Suspense fallback={<Reading what="Drawing…" />}>
          <TopologyGraph clusterId={clusterId} graph={g} />
        </Suspense>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
          <Network size={28} className="text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Nothing runs{ns ? ` in ${ns}` : ''} yet.</p>
        </div>
      )}
    </div>
  );
}
