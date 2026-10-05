import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DeployRelease } from '@smt/shared';
import { History } from 'lucide-react';
import { api } from '@/lib/api.js';
import { appPath, deployKeys, when } from '@/lib/deploy.js';
import { cn } from '@/lib/utils.js';
import ConfirmDialog from '@/components/docker/ConfirmDialog.js';

const RESULT_STYLE: Record<DeployRelease['result'], string> = {
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-red-500/10 text-red-600',
  building: 'bg-amber-500/10 text-amber-600',
};

/**
 * The app's kept releases, newest first (spec §5). A successful release whose
 * image is still on the server can be served again — a rollback switches the
 * proxy to it without rebuilding.
 */
export default function ReleasesPanel({
  serverId,
  app,
  canOperate,
  busy,
  onRollback,
}: {
  serverId: string;
  app: string;
  canOperate: boolean;
  /** A deploy or rollback is running from this page. */
  busy: boolean;
  onRollback: (release: string) => void;
}) {
  const [confirm, setConfirm] = useState<DeployRelease | null>(null);
  const releases = useQuery<DeployRelease[]>({
    queryKey: deployKeys.releases(serverId, app),
    queryFn: () => api.get(appPath(serverId, app, '/releases')),
  });

  if (releases.isLoading) return <p className="text-sm text-muted-foreground">Loading releases…</p>;
  if (releases.error) return <p className="text-sm text-red-600">{(releases.error as Error).message}</p>;
  const list = releases.data ?? [];
  if (list.length === 0) return <p className="text-sm text-muted-foreground">No releases yet. Deploy a build to create the first.</p>;

  return (
    <>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Release</th>
              <th className="px-3 py-2 font-medium">Deployed</th>
              <th className="px-3 py-2 font-medium">By</th>
              <th className="px-3 py-2 font-medium">Result</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const canRollback = canOperate && !r.current && r.result === 'success' && r.imagePresent;
              return (
                <tr key={r.id} aria-label={`Release ${r.id}`} className="border-b border-border align-top last:border-0">
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs">{r.id}</span>
                    {r.current && <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">current</span>}
                    <span className="block font-mono text-[11px] text-muted-foreground" title={`SHA-256 of the upload: ${r.checksum}`}>
                      {r.buildType} · {r.checksum.slice(0, 12)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">{when(r.createdAt)}</td>
                  <td className="px-3 py-2 text-xs">{r.actor}</td>
                  <td className="px-3 py-2">
                    <span className={cn('rounded px-1.5 py-0.5 text-xs', RESULT_STYLE[r.result])}>{r.result}</span>
                    {r.error && (
                      <span className="mt-1 block max-w-xs truncate text-xs text-red-600" title={r.error}>
                        {r.error.split('\n')[0]}
                      </span>
                    )}
                    {!r.imagePresent && r.result === 'success' && <span className="mt-1 block text-xs text-muted-foreground">Image pruned</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canRollback && (
                      <button
                        onClick={() => setConfirm(r)}
                        disabled={busy}
                        aria-label={`Roll back to ${r.id}`}
                        className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
                      >
                        <History size={13} /> Roll back
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {confirm && (
        <ConfirmDialog
          title={`Roll back ${app}`}
          subject={confirm.id}
          confirmLabel="Roll back"
          danger={false}
          onConfirm={async () => onRollback(confirm.id)}
          onClose={() => setConfirm(null)}
        >
          <p>Serves this release again from its kept image — no rebuild. The current release stays in the list to switch back to.</p>
        </ConfirmDialog>
      )}
    </>
  );
}
