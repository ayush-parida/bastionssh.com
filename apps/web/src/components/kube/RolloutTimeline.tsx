import type { ReactNode } from 'react';
import type { KubeRevision, KubeRollout } from '@smt/shared';
import { cn } from '@/lib/utils.js';
import { ago } from '@/lib/kube.js';

/**
 * A Deployment's rollout (spec §5.3): revisions as a horizontal timeline,
 * oldest left — what image each ran, when, and the change-cause annotation —
 * with the current one highlighted; during a rollout, desired / updated /
 * ready / available replicas as one stacked bar. `action` lets a later phase
 * put a "Roll back to this revision" button on past entries;
 * `showRevisions={false}` keeps only the bar, for when the guided actions'
 * revision list (with its rollback buttons, K3) shows them instead.
 */

/** `registry/shop/web:1.4.2` → `web:1.4.2`. */
function shortImage(image: string): string {
  return image.split('/').pop() ?? image;
}

function ReplicaBar({ replicas: r }: { replicas: KubeRollout['replicas'] }) {
  const total = Math.max(r.desired, r.updated, r.ready, 1);
  const available = Math.min(r.available, r.ready);
  const segments = [
    { n: available, cls: 'bg-emerald-500', label: 'available, serving' },
    { n: Math.max(0, r.ready - available), cls: 'bg-teal-400', label: 'ready, not yet available' },
    { n: Math.max(0, r.updated - r.ready), cls: 'bg-sky-400', label: 'updated, starting' },
    { n: Math.max(0, r.desired - Math.max(r.updated, r.ready)), cls: 'bg-zinc-300 dark:bg-zinc-600', label: 'still on the old version' },
  ];
  return (
    <div className="space-y-1" data-testid="rollout-bar">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
        {segments.map((s) =>
          s.n ? <div key={s.label} className={s.cls} style={{ width: `${(s.n / total) * 100}%` }} title={`${s.n} ${s.label}`} /> : null,
        )}
      </div>
      <p className="text-xs tabular-nums text-muted-foreground">
        {r.desired} desired · {r.updated} updated · {r.ready} ready · {r.available} available
      </p>
      {/* What each colour of the bar is, for the parts it has */}
      <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground" data-testid="rollout-legend">
        {segments
          .filter((s) => s.n)
          .map((s) => (
            <span key={s.label} className="flex items-center gap-1">
              <span className={`size-2 rounded-full ${s.cls}`} />
              {s.n} {s.label}
            </span>
          ))}
      </p>
    </div>
  );
}

export default function RolloutTimeline({
  rollout,
  action,
  showRevisions = true,
}: {
  rollout: KubeRollout;
  action?: (revision: KubeRevision) => ReactNode;
  showRevisions?: boolean;
}) {
  const revisions = [...rollout.revisions].reverse();
  return (
    <div className="space-y-3" data-testid="rollout-timeline">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Rollout</p>
        {rollout.inProgress && <span className="rounded-full bg-sky-500/15 px-2 text-xs text-sky-700 dark:text-sky-400">rolling out</span>}
      </div>
      <ReplicaBar replicas={rollout.replicas} />
      {showRevisions && revisions.length > 0 && (
        <ol className="flex gap-0 overflow-x-auto pb-1">
          {revisions.map((r, i) => (
            <li key={r.replicaSet} className="relative flex min-w-[9.5rem] flex-1 flex-col items-start" data-testid="revision" data-current={r.current}>
              <div className="flex w-full items-center">
                <span
                  className={cn(
                    'z-10 flex size-6 shrink-0 items-center justify-center rounded-full border-2 text-[10px] font-semibold tabular-nums',
                    r.current ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground',
                  )}
                  title={`Revision ${r.revision}`}
                >
                  {r.revision}
                </span>
                {i < revisions.length - 1 && <span className="h-0.5 flex-1 bg-border" />}
              </div>
              <div className={cn('mt-1.5 space-y-0.5 pr-3 text-xs', !r.current && 'text-muted-foreground')}>
                <p className="truncate font-mono" title={r.images.join(', ')}>
                  {r.images.map(shortImage).join(', ') || '—'}
                </p>
                {r.changeCause && (
                  <p className="line-clamp-2 break-words" title={r.changeCause}>
                    {r.changeCause}
                  </p>
                )}
                <p>
                  {ago(r.createdAt)}
                  {r.current ? ' · current' : r.replicas ? ` · ${r.readyReplicas}/${r.replicas} still running` : ''}
                </p>
                {!r.current && action?.(r)}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
