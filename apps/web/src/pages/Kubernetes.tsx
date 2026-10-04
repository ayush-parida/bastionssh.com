import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { KubeCluster, KubeTestResult } from '@smt/shared';
import { LayoutGrid, Loader2, Pencil, PlugZap, Plus, ShipWheel, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { cn, relativeTime } from '@/lib/utils.js';
import { CLUSTER_DOT, CLUSTER_STATUS_LABEL, kubeKeys, kubeTabUrl } from '@/lib/kube.js';
import { useHasRole } from '@/store/auth.js';
import { useAccessLevels } from '@/hooks/useAccessLevels.js';
import { DiagnoseButton } from '@/components/diagnostics/Diagnostics.js';
import ConfirmDialog from '@/components/docker/ConfirmDialog.js';
import ClusterDialog from '@/components/kube/ClusterDialog.js';
import TestResult from '@/components/kube/TestResult.js';

function viaLabel(c: KubeCluster): string {
  if (c.connectVia === 'server') return `through ${c.viaServerName ?? 'a server'}`;
  if (c.connectVia === 'agent') return `through agent ${c.viaAgentName ?? ''}`.trim();
  return 'direct';
}

/**
 * Kubernetes clusters the caller may use, each with a health dot from its
 * last test or use. Admins add, edit, test and remove them; a card opens the
 * cluster's map.
 */
export default function KubernetesPage() {
  const qc = useQueryClient();
  const isAdmin = useHasRole('admin');
  // Testing, editing and removing a cluster is managing it (custom roles spec §5)
  const access = useAccessLevels('cluster');
  const [editing, setEditing] = useState<KubeCluster | 'new' | null>(null);
  const [removing, setRemoving] = useState<KubeCluster | null>(null);
  const [tested, setTested] = useState<{ cluster: KubeCluster; result: KubeTestResult } | null>(null);

  const clusters = useQuery<KubeCluster[]>({ queryKey: kubeKeys.clusters, queryFn: () => api.get('/kube/clusters') });

  const test = useMutation({
    mutationFn: (c: KubeCluster) => api.post<KubeTestResult>(`/kube/clusters/${c.id}/test`, {}),
    onSuccess: (result, cluster) => {
      setTested({ cluster, result });
      qc.invalidateQueries({ queryKey: kubeKeys.clusters });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Kubernetes</h1>
          <p className="text-sm text-muted-foreground">
            See what runs on your clusters, how it is connected and what is unhealthy — no kubectl needed.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!!clusters.data?.length && (
            <Link
              to="/kubernetes/overview"
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
            >
              <LayoutGrid size={14} /> Overview
            </Link>
          )}
          {isAdmin && (
            <button
              onClick={() => setEditing('new')}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Plus size={14} /> Add cluster
            </button>
          )}
        </div>
      </div>

      {clusters.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : clusters.error ? (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(clusters.error as Error).message}</p>
      ) : !clusters.data?.length ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
          <ShipWheel size={28} className="text-muted-foreground" />
          <p className="text-sm font-medium">No clusters yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            {isAdmin
              ? 'Add a cluster from a kubeconfig or a service account token. Private clusters can be reached through a server or agent you already manage.'
              : 'An admin has not added a cluster you can see.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {clusters.data.map((c) => (
            <div key={c.id} className="flex flex-col rounded-lg border border-border bg-card" data-testid="cluster-card">
              <Link to={kubeTabUrl(c.id)} className="flex-1 space-y-2 p-4 hover:bg-muted/30">
                <div className="flex items-center gap-2">
                  <span className={cn('size-2.5 shrink-0 rounded-full', CLUSTER_DOT[c.lastStatus])} title={CLUSTER_STATUS_LABEL[c.lastStatus]} />
                  <span className="truncate font-semibold">{c.name}</span>
                  {c.serverVersion && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{c.serverVersion}</span>}
                </div>
                <p className="truncate font-mono text-xs text-muted-foreground" title={c.apiUrl}>
                  {c.apiUrl}
                </p>
                <p className="text-xs text-muted-foreground">
                  {CLUSTER_STATUS_LABEL[c.lastStatus]}
                  {c.lastCheckedAt && ` · checked ${relativeTime(c.lastCheckedAt)}`} · {viaLabel(c)}
                  {c.namespacesAllowlist && ` · ${c.namespacesAllowlist.length} namespace${c.namespacesAllowlist.length === 1 ? '' : 's'}`}
                  {c.impersonate && ' · acts as each member'}
                </p>
                {c.lastStatus === 'error' && c.lastError && <p className="line-clamp-2 text-xs text-red-600">{c.lastError}</p>}
              </Link>
              <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
                <DiagnoseButton target={{ kind: 'kube_cluster', id: c.id, name: c.name }} />
                {access.can(c.id, 'manage') && (
                  <>
                    <button
                      onClick={() => test.mutate(c)}
                      disabled={test.isPending}
                      className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                    >
                      {test.isPending && test.variables?.id === c.id ? <Loader2 size={12} className="animate-spin" /> : <PlugZap size={12} />} Test
                    </button>
                    <button onClick={() => setEditing(c)} className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-muted" title="Edit">
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => setRemoving(c)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-red-600" title="Remove">
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && <ClusterDialog cluster={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}

      {removing && (
        <ConfirmDialog
          title="Remove cluster"
          subject={removing.name}
          confirmLabel="Remove"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api.delete(`/kube/clusters/${removing.id}`);
            qc.invalidateQueries({ queryKey: kubeKeys.clusters });
            toast.success(`${removing.name} removed`);
          }}
        >
          Its saved credential and member grants are deleted, and open views close. Nothing changes on the cluster itself.
        </ConfirmDialog>
      )}

      {tested && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={(e) => e.target === e.currentTarget && setTested(null)}>
          <div role="dialog" aria-modal="true" className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl">
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <PlugZap size={16} className="shrink-0 text-primary" />
              <span className="flex-1 truncate text-sm font-semibold">Test {tested.cluster.name}</span>
              <button onClick={() => setTested(null)} className="text-muted-foreground hover:text-foreground" title="Close">
                <X size={14} />
              </button>
            </div>
            <div className="overflow-y-auto p-4">
              <TestResult result={tested.result} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
