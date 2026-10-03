import { useState } from 'react';
import type { KubeRevision } from '@smt/shared';
import { kubeActionCommand } from '@smt/shared';
import { History, Undo2 } from 'lucide-react';
import { cn, relativeTime } from '@/lib/utils.js';
import { revisionDiff, useKubeAction, type KubeContainerDiff } from '@/lib/kube-actions.js';
import ConfirmDialog from '@/components/docker/ConfirmDialog.js';
import WhatThisDoes from './WhatThisDoes.js';

/** What rolling back changes, per container: image, env names added and removed. Values never leave the cluster. */
function RevisionDiffView({ diff }: { diff: KubeContainerDiff[] }) {
  const changed = diff.filter((d) => d.change !== 'same');
  if (!changed.length) return <p className="text-xs text-muted-foreground">Images and environment variable names are the same.</p>;
  return (
    <ul className="space-y-2" data-testid="revision-diff">
      {changed.map((d) => (
        <li key={d.name} className="rounded-md border border-border px-3 py-2 text-xs">
          <p className="mb-1 font-medium">
            {d.name}
            {d.change !== 'changed' && <span className="ml-2 font-normal text-muted-foreground">container {d.change === 'added' ? 'comes back' : 'goes away'}</span>}
          </p>
          {d.imageFrom !== d.imageTo && (
            <p className="break-all font-mono">
              <span className="text-red-600 line-through decoration-red-600/60">{d.imageFrom ?? '—'}</span>
              <span className="mx-1.5 text-muted-foreground">→</span>
              <span className="text-emerald-600">{d.imageTo ?? '—'}</span>
            </p>
          )}
          {(d.envAdded.length > 0 || d.envRemoved.length > 0) && (
            <div className="mt-1 flex flex-wrap gap-1">
              {d.envAdded.map((n) => (
                <span key={`+${n}`} className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-emerald-700 dark:text-emerald-400">
                  + {n}
                </span>
              ))}
              {d.envRemoved.map((n) => (
                <span key={`-${n}`} className="rounded bg-red-500/10 px-1.5 py-0.5 font-mono text-red-600">
                  − {n}
                </span>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * A Deployment's revisions as a timeline, newest first (spec §5.3, §6): each
 * with when it was made, its change-cause and images, the one running now
 * highlighted. Admins get "Roll back to this" on past revisions; the
 * confirmation shows what changes (images and env var names) and names the
 * Deployment. The server copies that revision's ReplicaSet template back into
 * the Deployment, as `kubectl rollout undo --to-revision` does.
 */
export default function RollbackPicker({
  clusterId,
  namespace,
  name,
  revisions,
  canRollback,
  paused,
}: {
  clusterId: string;
  namespace: string;
  name: string;
  revisions: KubeRevision[];
  canRollback: boolean;
  paused?: boolean;
}) {
  const run = useKubeAction(clusterId);
  const [target, setTarget] = useState<KubeRevision | null>(null);
  const current = revisions.find((r) => r.current) ?? null;

  return (
    <div className="space-y-2" data-testid="revision-timeline">
      <p className="flex items-center gap-2 text-sm font-medium">
        <History size={14} /> Revisions
        {paused && <span className="text-xs font-normal text-muted-foreground">· rollout paused</span>}
      </p>
      <ol className="relative ml-1.5 space-y-3 border-l border-border pl-4">
        {revisions.map((r) => (
          <li key={r.revision} className="relative" data-testid="revision" data-current={r.current || undefined}>
            <span
              className={cn(
                'absolute -left-[21.5px] top-1 size-3 rounded-full border-2 border-card',
                r.current ? 'bg-emerald-500 ring-2 ring-emerald-500/30' : 'bg-zinc-400',
              )}
            />
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <span className="font-medium">Revision {r.revision}</span>
                  {r.current && <span className="ml-2 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-400">running now</span>}
                  {r.createdAt && <span className="ml-2 text-xs text-muted-foreground">{relativeTime(r.createdAt)}</span>}
                </p>
                {r.changeCause && <p className="truncate text-xs text-muted-foreground" title={r.changeCause}>{r.changeCause}</p>}
                <p className="mt-0.5 flex flex-wrap gap-1">
                  {r.containers.map((c) => (
                    <span key={c.name} className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]" title={`${c.name}: ${c.image}`}>
                      {c.image}
                    </span>
                  ))}
                  {r.replicas > 0 && <span className="text-[11px] text-muted-foreground">{r.replicas} pod{r.replicas === 1 ? '' : 's'}</span>}
                </p>
              </div>
              {canRollback && !r.current && (
                <button
                  type="button"
                  disabled={paused}
                  onClick={() => setTarget(r)}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40"
                  title={paused ? 'Resume the rollout first' : undefined}
                >
                  <Undo2 size={12} /> Roll back to this
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>

      {target && (
        <ConfirmDialog
          title="Roll back Deployment"
          subject={`deployment/${name} in ${namespace}`}
          confirmLabel={`Roll back ${name} to revision ${target.revision}`}
          onConfirm={() => run('rollback', { namespace, name, revision: target.revision })}
          onClose={() => setTarget(null)}
        >
          <p>
            From {current ? `revision ${current.revision}` : 'the running version'} back to <span className="font-medium">revision {target.revision}</span>
            {target.changeCause ? ` (${target.changeCause})` : ''}. Pods are replaced one by one.
          </p>
          <RevisionDiffView diff={revisionDiff(current?.containers ?? [], target.containers)} />
          <p className="text-xs text-muted-foreground">Only names are compared; values stay on the cluster.</p>
          <WhatThisDoes command={kubeActionCommand('rollback', { kind: 'Deployment', namespace, name }, { revision: target.revision })}>
            Copies the pod template of revision {target.revision}&apos;s ReplicaSet back into the Deployment, which rolls it out as a new revision.
          </WhatThisDoes>
        </ConfirmDialog>
      )}
    </div>
  );
}
