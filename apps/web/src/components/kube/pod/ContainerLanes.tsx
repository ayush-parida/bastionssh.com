import type { KubeContainerRole, KubeContainerView, KubePodDetail, KubePodLifecycleStep } from '@smt/shared';
import { Check, ChevronRight, Clock, History, RotateCcw, ScrollText, SquareTerminal, X } from 'lucide-react';
import { cn, relativeTime } from '@/lib/utils.js';
import UsageBars from './UsageBars.js';

/**
 * Inside a pod, as a picture (spec §5.3): the lifecycle strip (Scheduled →
 * Initialized → Started → Ready, where it is stuck and why), then one lane
 * per container in the order they run — init containers one after the other,
 * native sidecars, the app, debug containers — each with its state in a word
 * and a colour, restarts, how the previous run ended, and usage against what
 * it asked for. Each lane opens that container's logs or a shell in it.
 */

const ROLE_LABEL: Record<KubeContainerRole, string> = {
  init: 'Init',
  sidecar: 'Sidecar',
  app: 'App',
  ephemeral: 'Debug',
};

const ROLE_HINT: Record<KubeContainerRole, string> = {
  init: 'Runs to completion before the app starts',
  sidecar: 'Starts before the app and runs beside it',
  app: 'The pod’s main container',
  ephemeral: 'Added later to debug the pod',
};

type Tone = 'ok' | 'busy' | 'bad' | 'done' | 'idle';

const TONE_STYLE: Record<Tone, { dot: string; badge: string; lane: string }> = {
  ok: { dot: 'bg-emerald-500', badge: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400', lane: 'border-l-emerald-500' },
  busy: { dot: 'bg-amber-400', badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-400', lane: 'border-l-amber-400' },
  bad: { dot: 'bg-red-500', badge: 'bg-red-500/10 text-red-700 dark:text-red-400', lane: 'border-l-red-500' },
  done: { dot: 'bg-zinc-400', badge: 'bg-muted text-muted-foreground', lane: 'border-l-zinc-400' },
  idle: { dot: 'bg-zinc-300 dark:bg-zinc-600', badge: 'bg-muted text-muted-foreground', lane: 'border-l-zinc-300 dark:border-l-zinc-600' },
};

/** Waiting reasons that are just the normal way up, not a problem. */
const STARTING = new Set(['ContainerCreating', 'PodInitializing']);

/** A container's state as a word and a colour. */
export function containerStatus(c: KubeContainerView): { label: string; tone: Tone } {
  if (c.state === 'running') {
    if (c.ready || c.role === 'ephemeral') return { label: 'Running', tone: 'ok' };
    return { label: 'Running, not ready', tone: 'busy' };
  }
  if (c.state === 'waiting') {
    if (!c.reason || STARTING.has(c.reason)) return { label: c.reason === 'PodInitializing' ? 'Waiting for init' : 'Starting', tone: 'busy' };
    return { label: c.reason, tone: 'bad' };
  }
  if (c.state === 'terminated') {
    if (c.exitCode === 0) return { label: c.role === 'init' ? 'Done' : 'Completed', tone: 'done' };
    return { label: `${c.reason ?? 'Exited'}${c.exitCode !== null ? ` (exit ${c.exitCode})` : ''}`, tone: 'bad' };
  }
  return { label: 'Not started', tone: 'idle' };
}

const STEP_STYLE: Record<KubePodLifecycleStep['status'], string> = {
  done: 'border-emerald-500 bg-emerald-500 text-white',
  pending: 'border-dashed border-muted-foreground/50 bg-card text-muted-foreground',
  failed: 'border-red-500 bg-red-500 text-white',
};

/** Scheduled → Initialized → Started → Ready, with where it is stuck. */
export function LifecycleStrip({ steps }: { steps: KubePodLifecycleStep[] }) {
  const stuck = steps.find((s) => s.status !== 'done' && s.detail);
  return (
    <div data-testid="pod-lifecycle">
      <ol className="flex items-center">
        {steps.map((s, i) => (
          <li key={s.id} className={cn('flex items-center', i < steps.length - 1 && 'flex-1')} data-status={s.status}>
            <div className="flex flex-col items-center gap-1" title={s.detail ?? (s.at ? new Date(s.at).toLocaleString() : s.label)}>
              <span className={cn('flex size-6 items-center justify-center rounded-full border-2', STEP_STYLE[s.status])}>
                {s.status === 'done' ? <Check size={13} /> : s.status === 'failed' ? <X size={13} /> : <Clock size={12} />}
              </span>
              <span className={cn('whitespace-nowrap text-[11px]', s.status === 'failed' ? 'font-medium text-red-600' : 'text-muted-foreground')}>
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span
                className={cn(
                  'mx-1 mb-5 h-0.5 flex-1',
                  s.status === 'done' && steps[i + 1]!.status === 'done' ? 'bg-emerald-500' : 'bg-border',
                )}
                aria-hidden
              />
            )}
          </li>
        ))}
      </ol>
      {stuck && (
        <p className={cn('mt-2 rounded-md px-3 py-2 text-xs', stuck.status === 'failed' ? 'bg-red-500/10 text-red-700 dark:text-red-400' : 'bg-muted text-muted-foreground')}>
          <span className="font-medium">{stuck.label}:</span> {stuck.detail}
        </p>
      )}
    </div>
  );
}

function Lane({
  container: c,
  metricsAvailable,
  canLogs,
  canExec,
  onLogs,
  onShell,
  shellBusy,
}: {
  container: KubeContainerView;
  metricsAvailable: boolean;
  canLogs: boolean;
  canExec: boolean;
  onLogs: (container: string, previous: boolean) => void;
  onShell: (container: string) => void;
  shellBusy: boolean;
}) {
  const status = containerStatus(c);
  const style = TONE_STYLE[status.tone];
  const last = c.lastTermination;
  return (
    <li
      className={cn('rounded-md border border-l-4 border-border bg-card p-3', style.lane)}
      data-testid="container-lane"
      data-role={c.role}
      data-tone={status.tone}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground" title={ROLE_HINT[c.role]}>
          {ROLE_LABEL[c.role]}
        </span>
        <span className="min-w-0 truncate font-mono text-sm font-medium" title={c.name}>
          {c.name}
        </span>
        <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs', style.badge)} data-testid="container-state">
          <span className={cn('size-1.5 rounded-full', style.dot)} />
          {status.label}
        </span>
        {c.restarts > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
            title="Times the kubelet restarted this container"
          >
            <RotateCcw size={11} /> {c.restarts} restart{c.restarts === 1 ? '' : 's'}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {canLogs && (
            <button
              onClick={() => onLogs(c.name, false)}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted"
              title={`Logs of ${c.name}`}
            >
              <ScrollText size={12} /> Logs
            </button>
          )}
          {canExec && c.state === 'running' && (
            <button
              onClick={() => onShell(c.name)}
              disabled={shellBusy}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
              title={`Open a shell in ${c.name} (recorded if your organisation records sessions)`}
            >
              <SquareTerminal size={12} /> Shell
            </button>
          )}
        </span>
      </div>

      <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={c.image}>
        {c.image}
        {c.ports.length > 0 && <span className="font-sans"> · ports {c.ports.map((p) => `${p.port}${p.protocol !== 'TCP' ? `/${p.protocol}` : ''}`).join(', ')}</span>}
        {c.since && c.state === 'running' && <span className="font-sans"> · up since {relativeTime(c.since)}</span>}
      </p>

      {c.message && status.tone === 'bad' && <p className="mt-1 text-xs text-red-700 dark:text-red-400">{c.message}</p>}

      {last && (
        <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground" data-testid="last-termination">
          <History size={11} />
          Previous run ended{last.reason ? `: ${last.reason}` : ''}
          {last.exitCode !== null && ` (exit ${last.exitCode})`}
          {last.finishedAt && `, ${relativeTime(last.finishedAt)}`}
          {last.reason === 'OOMKilled' && c.limits.memoryBytes !== null && ' — it hit its memory limit'}
          {canLogs && (
            <button onClick={() => onLogs(c.name, true)} className="ml-1 text-primary hover:underline">
              its logs
            </button>
          )}
        </p>
      )}

      <div className="mt-2">
        <UsageBars container={c} metricsAvailable={metricsAvailable} />
      </div>
    </li>
  );
}

/** Lanes in running order; an arrow between init steps shows they run one after another. */
export default function ContainerLanes({
  pod,
  canLogs,
  canExec,
  onLogs,
  onShell,
  shellBusy = false,
}: {
  pod: KubePodDetail;
  canLogs: boolean;
  canExec: boolean;
  onLogs: (container: string, previous: boolean) => void;
  onShell: (container: string) => void;
  shellBusy?: boolean;
}) {
  const init = pod.containers.filter((c) => c.role === 'init');
  const rest = pod.containers.filter((c) => c.role !== 'init');
  const lane = (c: KubeContainerView) => (
    <Lane
      key={c.name}
      container={c}
      metricsAvailable={pod.metricsAvailable}
      canLogs={canLogs}
      canExec={canExec}
      onLogs={onLogs}
      onShell={onShell}
      shellBusy={shellBusy}
    />
  );
  return (
    <div className="space-y-3" data-testid="container-lanes">
      {init.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-muted-foreground">First, in order</p>
          <ol className="space-y-1.5">
            {init.flatMap((c, i) => [
              lane(c),
              ...(i < init.length - 1
                ? [
                    <li key={`${c.name}→`} role="presentation" aria-hidden>
                      <ChevronRight size={14} className="mx-auto rotate-90 text-muted-foreground" />
                    </li>,
                  ]
                : []),
            ])}
          </ol>
        </div>
      )}
      {rest.length > 0 && (
        <div>
          {init.length > 0 && <p className="mb-1 text-xs text-muted-foreground">Then, side by side</p>}
          <ul className="space-y-1.5">{rest.map(lane)}</ul>
        </div>
      )}
      {!pod.metricsAvailable && (
        <p className="text-xs text-muted-foreground">Live usage needs a metrics server in the cluster; the bars show requests and limits only.</p>
      )}
    </div>
  );
}
