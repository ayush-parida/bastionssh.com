import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEPLOY_DOCS, type DeployBuilderPruneResult, type DeployBuilderStatus } from '@smt/shared';
import { CheckCircle2, Circle, Eraser, Hammer, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { builderKey, builderPath } from '@/lib/deploy.js';
import { formatBytes } from '@/lib/utils.js';
import ConfirmDialog from '@/components/docker/ConfirmDialog.js';
import DocsLink from '@/components/docs/DocsLink.js';

/**
 * BastionSSH's builder on the Setup line (bastion-side builds spec): one
 * BuildKit service for the whole BastionSSH, used by apps with
 * `build.where: bastion`. Says whether it is set up and reachable, its
 * platform (images for servers of another architecture are emulated), the
 * layer cache against its limit, and the build running now. Managers of
 * Deployments may clear the cache (the next build of each app starts cold).
 */
export default function BuilderStatus({ canClearCache }: { canClearCache: boolean }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const builder = useQuery<DeployBuilderStatus>({
    queryKey: builderKey,
    queryFn: () => api.get(builderPath),
    retry: false,
    staleTime: 15_000,
    // While a build runs, keep the line current
    refetchInterval: (q) => (q.state.data?.running ? 10_000 : false),
  });
  const b = builder.data;
  if (!b) return null;

  return (
    <div aria-label="Builder" className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-card px-4 py-2.5 text-sm">
      <span className="flex items-center gap-1.5">
        {!b.configured ? (
          <Circle size={14} className="text-muted-foreground" />
        ) : b.reachable ? (
          <CheckCircle2 size={14} className="text-emerald-500" />
        ) : (
          <TriangleAlert size={14} className="text-amber-500" />
        )}
        <Hammer size={13} className="text-muted-foreground" /> Builder
      </span>
      {!b.configured ? (
        <span className="text-muted-foreground">not set up on this BastionSSH: every app builds on its server</span>
      ) : !b.reachable ? (
        <span className="min-w-0 flex-1 break-words text-amber-700 dark:text-amber-400">unreachable{b.error ? `: ${b.error}` : ''}</span>
      ) : (
        <>
          <span className="text-muted-foreground">
            Platform <span className="font-mono text-foreground">{b.platform ?? 'unknown'}</span>
            {b.version && <span className="ml-1 text-xs">(BuildKit {b.version})</span>}
          </span>
          <span className="text-muted-foreground">
            Cache <span className="text-foreground">{formatBytes(b.cacheBytes ?? 0)}</span>
            {b.cacheLimitBytes ? ` of ${formatBytes(b.cacheLimitBytes)}` : ''}
          </span>
          <span className="text-muted-foreground">
            {b.running ? (
              <>
                Building <span className="font-mono text-foreground">{b.running.app}</span>
                {b.queued > 0 && `, ${b.queued} waiting`}
              </>
            ) : (
              'Idle'
            )}
          </span>
        </>
      )}
      <DocsLink to={DEPLOY_DOCS.bastionBuild} className="ml-auto text-xs">
        Build on BastionSSH
      </DocsLink>
      {b.reachable && canClearCache && (
        <button
          onClick={() => setConfirming(true)}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
        >
          <Eraser size={12} /> Clear build cache
        </button>
      )}
      {confirming && (
        <ConfirmDialog
          title="Clear build cache"
          subject="BuildKit"
          confirmLabel="Clear build cache"
          danger={false}
          onConfirm={async () => {
            const res = await api.post<DeployBuilderPruneResult>(`${builderPath}/prune`);
            toast.success(`Build cache cleared: ${formatBytes(res.reclaimedBytes)} freed`);
            await qc.invalidateQueries({ queryKey: builderKey });
          }}
          onClose={() => setConfirming(false)}
        >
          <p>
            Removes the builder&apos;s cached layers and dependency downloads. Nothing on your servers changes; the next build of each app starts from
            scratch and takes longer. A build running now keeps what it uses.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
