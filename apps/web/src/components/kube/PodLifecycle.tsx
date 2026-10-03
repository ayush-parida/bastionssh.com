import type { KubeContainerLane, KubeLifecycleStep } from '@smt/shared';
import { Check, Circle, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { ago } from '@/lib/kube.js';

/**
 * A pod's life at a glance (spec §5.3): the lifecycle strip Scheduled →
 * Pulled → Started → Ready from its conditions and events, and its
 * containers as lanes — init containers, then the app, then sidecars — with
 * their state, restarts and last termination.
 */

const STEP_STYLE: Record<KubeLifecycleStep['state'], { icon: typeof Check; cls: string }> = {
  done: { icon: Check, cls: 'border-emerald-500 bg-emerald-500 text-white' },
  current: { icon: Loader2, cls: 'border-sky-500 text-sky-500' },
  failed: { icon: X, cls: 'border-red-500 bg-red-500 text-white' },
  waiting: { icon: Circle, cls: 'border-border text-muted-foreground' },
};

export function LifecycleStrip({ steps }: { steps: KubeLifecycleStep[] }) {
  return (
    <ol className="flex" data-testid="lifecycle-strip">
      {steps.map((s, i) => {
        const { icon: Icon, cls } = STEP_STYLE[s.state];
        return (
          <li key={s.id} className="flex min-w-0 flex-1 flex-col" data-testid="lifecycle-step" data-state={s.state}>
            <div className="flex items-center">
              <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full border-2', cls)}>
                <Icon size={12} className={s.state === 'current' ? 'animate-spin' : undefined} />
              </span>
              {i < steps.length - 1 && <span className={cn('h-0.5 flex-1', s.state === 'done' ? 'bg-emerald-500' : 'bg-border')} />}
            </div>
            <div className="mt-1 pr-2 text-xs">
              <p className={cn('font-medium', s.state === 'failed' && 'text-red-600', s.state === 'waiting' && 'text-muted-foreground')}>{s.label}</p>
              {s.at && <p className="text-muted-foreground">{ago(s.at)}</p>}
              {s.detail && (
                <p className={cn('line-clamp-3 break-words', s.state === 'failed' ? 'text-red-600' : 'text-muted-foreground')} title={s.detail}>
                  {s.detail}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const LANE_STATE: Record<KubeContainerLane['state'], string> = {
  running: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  waiting: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  terminated: 'bg-zinc-500/15 text-muted-foreground',
  unknown: 'bg-muted text-muted-foreground',
};

export function ContainerLanes({ lanes }: { lanes: KubeContainerLane[] }) {
  return (
    <ul className="divide-y divide-border rounded-md border border-border" data-testid="container-lanes">
      {lanes.map((c) => {
        const bad = c.reason && /BackOff|Err|Error|OOM/i.test(c.reason);
        return (
          <li key={`${c.role}/${c.name}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" data-testid="container-lane">
            <span className="w-14 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">{c.role}</span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{c.name}</span>
              {c.image && <span className="ml-2 truncate font-mono text-xs text-muted-foreground">{c.image}</span>}
            </span>
            <span className={cn('rounded-full px-2 text-xs', bad ? 'bg-red-500/15 text-red-600' : LANE_STATE[c.state])}>
              {c.reason ?? c.state}
              {c.state === 'running' && !c.ready && c.role !== 'init' ? ' · not ready' : ''}
            </span>
            {c.restarts > 0 && <span className="text-xs tabular-nums text-amber-600">{c.restarts} restarts</span>}
            {c.lastTermination && (
              <span className="w-full pl-[4.25rem] text-xs text-muted-foreground">
                Last ended: {c.lastTermination.reason ?? 'exited'}
                {c.lastTermination.exitCode !== null && ` (exit code ${c.lastTermination.exitCode})`}
                {c.lastTermination.finishedAt && `, ${ago(c.lastTermination.finishedAt)}`}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
