import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { KubeOverview } from '@smt/shared';
import { kubeObjectUrl } from '@smt/shared';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { formatCpu, formatMemory, kubeKeys, kubePath, percent, useKubeChanges, type KubeObjectLinkState } from '@/lib/kube.js';
import CordonToggle from './actions/CordonToggle.js';

/**
 * Nodes as a table: the same data as the map, sorted for comparing capacity.
 * Admins cordon / uncordon from the switch beside each node's status.
 */
export default function NodesTab({ clusterId }: { clusterId: string; namespace: string }) {
  const overview = useQuery<KubeOverview>({
    queryKey: kubeKeys.overview(clusterId),
    queryFn: () => api.get(kubePath(clusterId, '/overview')),
    retry: false,
  });
  useKubeChanges(clusterId, 'overview', {}, kubeKeys.overview(clusterId), overview.isSuccess);

  if (overview.error) return <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(overview.error as Error).message}</p>;
  if (!overview.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Node</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">CPU requested</th>
            <th className="px-4 py-2 font-medium">Memory requested</th>
            <th className="px-4 py-2 font-medium">Pods</th>
            <th className="px-4 py-2 font-medium">Kubelet</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {overview.data.nodes.map((n) => (
            <tr key={n.name} className="hover:bg-muted/40">
              <td className="px-4 py-2">
                <Link
                  className="font-medium hover:underline"
                  to={kubeObjectUrl(clusterId, { resource: 'nodes', namespace: null, name: n.name })}
                  state={{ tab: 'nodes' } satisfies KubeObjectLinkState}
                >
                  {n.name}
                </Link>
                <span className="ml-2 text-xs text-muted-foreground">{n.roles.join(', ')}</span>
              </td>
              <td className="px-4 py-2">
                <span className={cn('rounded px-1.5 py-0.5 text-xs', n.ready ? 'bg-emerald-500/10 text-emerald-600' : 'bg-red-500/10 text-red-600')}>
                  {n.ready ? 'Ready' : 'Not ready'}
                </span>
                {n.unschedulable && <span className="ml-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600">Cordoned</span>}
                <span className="ml-1 inline-flex align-middle">
                  <CordonToggle clusterId={clusterId} node={n.name} unschedulable={n.unschedulable} pods={n.pods.filter((p) => p.status !== 'completed').length} compact />
                </span>
              </td>
              <td className="px-4 py-2 tabular-nums">
                {formatCpu(n.requested.cpuMillis)} / {formatCpu(n.allocatable.cpuMillis)}{' '}
                <span className="text-muted-foreground">({percent(n.requested.cpuMillis, n.allocatable.cpuMillis)}%)</span>
              </td>
              <td className="px-4 py-2 tabular-nums">
                {formatMemory(n.requested.memoryBytes)} / {formatMemory(n.allocatable.memoryBytes)}{' '}
                <span className="text-muted-foreground">({percent(n.requested.memoryBytes, n.allocatable.memoryBytes)}%)</span>
              </td>
              <td className="px-4 py-2 tabular-nums">{n.pods.filter((p) => p.status !== 'completed').length}</td>
              <td className="px-4 py-2 text-xs text-muted-foreground">{n.kubeletVersion ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
