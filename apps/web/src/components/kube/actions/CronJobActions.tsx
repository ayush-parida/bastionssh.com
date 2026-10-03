import { useState } from 'react';
import type { KubeActionPreview } from '@smt/shared';
import { kubeActionCommand } from '@smt/shared';
import { CalendarClock, Play } from 'lucide-react';
import { cn, relativeTime } from '@/lib/utils.js';
import { useKubeAction } from '@/lib/kube-actions.js';
import ConfirmDialog from '@/components/docker/ConfirmDialog.js';
import WhatThisDoes from './WhatThisDoes.js';

type Pending = 'suspend' | 'resume' | 'trigger' | null;

/**
 * A CronJob's schedule switch (suspend / resume) and "Run now" (spec §6).
 * Running now creates a Job from the CronJob's template under a generated
 * name, owned by the CronJob — the schedule is not touched.
 */
export default function CronJobActions({
  clusterId,
  namespace,
  name,
  cronJob,
  canSuspend,
  canTrigger,
}: {
  clusterId: string;
  namespace: string;
  name: string;
  cronJob: NonNullable<KubeActionPreview['cronJob']>;
  canSuspend: boolean;
  canTrigger: boolean;
}) {
  const run = useKubeAction(clusterId);
  const [pending, setPending] = useState<Pending>(null);
  const target = { kind: 'CronJob', namespace, name };
  const onSchedule = !cronJob.suspended;

  return (
    <div className="space-y-2" data-testid="cronjob-actions">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <CalendarClock size={14} /> Schedule <span className="font-mono text-xs font-normal">{cronJob.schedule}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {onSchedule ? 'Runs on schedule' : 'Suspended — no new runs start'}
            {cronJob.lastScheduleTime && ` · last run ${relativeTime(cronJob.lastScheduleTime)}`}
            {cronJob.active > 0 && ` · ${cronJob.active} running now`}
          </p>
        </div>
        {canSuspend && (
          <button
            type="button"
            role="switch"
            aria-checked={onSchedule}
            aria-label={`Run ${name} on schedule`}
            data-testid="suspend-toggle"
            onClick={() => setPending(onSchedule ? 'suspend' : 'resume')}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-muted"
          >
            <span className={cn('relative h-4 w-7 rounded-full transition-colors', onSchedule ? 'bg-emerald-500' : 'bg-zinc-400')}>
              <span className={cn('absolute top-0.5 size-3 rounded-full bg-white shadow transition-[left]', onSchedule ? 'left-3.5' : 'left-0.5')} />
            </span>
            <span className="text-muted-foreground">{onSchedule ? 'On' : 'Suspended'}</span>
          </button>
        )}
        {canTrigger && (
          <button
            type="button"
            onClick={() => setPending('trigger')}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            <Play size={13} /> Run now…
          </button>
        )}
      </div>

      {(pending === 'suspend' || pending === 'resume') && (
        <ConfirmDialog
          title={pending === 'suspend' ? 'Suspend CronJob' : 'Resume CronJob'}
          subject={`cronjob/${name} in ${namespace}`}
          confirmLabel={pending === 'suspend' ? `Suspend ${name}` : `Resume ${name}`}
          danger={false}
          onConfirm={() => run('suspend-cronjob', { namespace, name, suspend: pending === 'suspend' })}
          onClose={() => setPending(null)}
        >
          <p>
            {pending === 'suspend'
              ? 'No new runs start until it is resumed. A run already going carries on.'
              : `Runs start again at the next scheduled time (${cronJob.schedule}). Missed runs are not made up beyond what the CronJob's own policy allows.`}
          </p>
          <WhatThisDoes command={kubeActionCommand('suspend-cronjob', target, { suspend: pending === 'suspend' })}>
            Sets <code className="font-mono">spec.suspend</code> to {String(pending === 'suspend')} on the CronJob.
          </WhatThisDoes>
        </ConfirmDialog>
      )}

      {pending === 'trigger' && (
        <ConfirmDialog
          title="Run CronJob now"
          subject={`cronjob/${name} in ${namespace}`}
          confirmLabel={`Run ${name} now`}
          danger={false}
          onConfirm={() => run('trigger-cronjob', { namespace, name })}
          onClose={() => setPending(null)}
        >
          <p>
            Starts one run right away, as a Job named <span className="font-mono">{name}-manual-…</span>. The schedule is unchanged
            {cronJob.suspended ? ' (it stays suspended)' : ''}
            {cronJob.active > 0 ? `; ${cronJob.active} run${cronJob.active === 1 ? ' is' : 's are'} already going` : ''}.
          </p>
          <WhatThisDoes command={kubeActionCommand('trigger-cronjob', target, { jobName: `${name}-manual-xxxxx` })}>
            Creates a Job from the CronJob&apos;s job template, owned by the CronJob so it shows up under it and is cleaned up with it.
          </WhatThisDoes>
        </ConfirmDialog>
      )}
    </div>
  );
}
