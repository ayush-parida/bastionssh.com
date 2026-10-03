import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { KubeClusterStatusView, KubeOverview } from '@smt/shared';
import { Radar } from 'lucide-react';
import { api } from '@/lib/api.js';
import { kubeKeys, kubePath, useKubeChanges } from '@/lib/kube.js';
import ClusterMap from './ClusterMap.js';

/** Map: the cluster map, kept live by the change feed. */
export default function MapTab({ clusterId, namespace }: { clusterId: string; namespace: string }) {
  const overview = useQuery<KubeOverview>({
    queryKey: kubeKeys.overview(clusterId),
    queryFn: () => api.get(kubePath(clusterId, '/overview')),
    retry: false,
  });
  useKubeChanges(clusterId, 'overview', {}, kubeKeys.overview(clusterId), overview.isSuccess);

  // Reading the map records the cluster as reachable: refresh a health dot that still says otherwise
  const qc = useQueryClient();
  useEffect(() => {
    if (!overview.isSuccess) return;
    const status = qc.getQueryData<KubeClusterStatusView>(kubeKeys.cluster(clusterId));
    if (status && status.cluster.lastStatus !== 'ok') {
      void qc.invalidateQueries({ queryKey: kubeKeys.cluster(clusterId) });
      void qc.invalidateQueries({ queryKey: kubeKeys.clusters });
    }
  }, [overview.isSuccess, qc, clusterId]);

  if (overview.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        <Radar size={15} className="animate-pulse" /> Reading the cluster…
      </div>
    );
  }
  if (overview.error) {
    return <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(overview.error as Error).message}</p>;
  }
  return overview.data ? <ClusterMap clusterId={clusterId} overview={overview.data} namespace={namespace} /> : null;
}
