import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DeployLogLine, DeployOutcome, DeployStreamEvent, DeployValidationIssue } from '@smt/shared';
import { CheckCircle2, Loader2, TriangleAlert, X, XCircle } from 'lucide-react';
import { appPath, deployKeys, followDeployStream, uploadDeploy, validationIssues } from '@/lib/deploy.js';
import { deployFailureHint } from '@/lib/deploy-help.js';
import { cn, formatBytes } from '@/lib/utils.js';
import DocsLink from '@/components/docs/DocsLink.js';

const MAX_LINES = 5_000;

type Phase = 'idle' | 'packing' | 'uploading' | 'running' | 'success' | 'failed';

/** A deploy or rollback of an app, or a quick service created or moved to another version (a deploy follows both). */
export type DeployRunKind = 'deploy' | 'rollback' | 'create' | 'update';

export interface DeployRunState {
  kind: DeployRunKind;
  phase: Phase;
  /** What is being sent, for the header: a file name or `release <id>`. */
  label: string;
  progress: { loaded: number; total: number } | null;
  lines: DeployLogLine[];
  outcome: DeployOutcome | null;
  error: string | null;
  /** bastionctl's problems with a config, when the request was refused for one (422). */
  issues: DeployValidationIssue[] | null;
  exit: Extract<DeployStreamEvent, { type: 'exit' }> | null;
}

const IDLE: DeployRunState = { kind: 'deploy', phase: 'idle', label: '', progress: null, lines: [], outcome: null, error: null, issues: null, exit: null };

/**
 * One deploy or rollback of an app at a time, from this page: packing and
 * upload progress, then the server's log as it streams, then the outcome.
 * Leaving the page stops following the log, not the deploy — the server runs
 * it to the end and audits it.
 */
export function useDeployRun(serverId: string, app: string) {
  const qc = useQueryClient();
  const [state, setState] = useState<DeployRunState>(IDLE);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);
  // Another app's run is not this one's
  useEffect(() => {
    abort.current?.abort();
    setState(IDLE);
  }, [serverId, app]);

  const onEvent = useCallback((event: DeployStreamEvent) => {
    setState((s) => {
      switch (event.type) {
        case 'log': {
          const lines = s.lines.concat(event.lines);
          return { ...s, lines: lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines };
        }
        case 'result':
          return { ...s, outcome: event.outcome, error: event.outcome.error };
        case 'error':
          return { ...s, phase: 'failed', error: event.error };
        case 'exit':
          return { ...s, exit: event };
        case 'end':
          return { ...s, phase: s.outcome?.result === 'success' ? 'success' : 'failed' };
        default:
          return s;
      }
    });
  }, []);

  const finish = useCallback(
    (controller: AbortController, err?: unknown) => {
      if (controller.signal.aborted) return;
      setState((s) => {
        if (err) return { ...s, phase: 'failed', error: err instanceof Error ? err.message : String(err), issues: validationIssues(err) };
        // The stream ended without an `end` (connection lost)
        if (s.phase === 'running' || s.phase === 'uploading') {
          return { ...s, phase: 'failed', error: s.error ?? 'The connection ended before the deploy finished. It may still be running on the server.' };
        }
        return s;
      });
      qc.invalidateQueries({ queryKey: deployKeys.all(serverId) });
    },
    [qc, serverId],
  );

  /** Upload `source` (packed by the caller) and deploy it. `pack` runs first, with the panel showing "Packing". */
  const deploy = useCallback(
    async (label: string, pack: () => Promise<{ blob: Blob; filename: string }>) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setState({ ...IDLE, kind: 'deploy', phase: 'packing', label });
      try {
        const { blob, filename } = await pack();
        if (controller.signal.aborted) return;
        setState((s) => ({ ...s, phase: 'uploading', progress: { loaded: 0, total: blob.size } }));
        await uploadDeploy(
          appPath(serverId, app, '/deploy'),
          blob,
          filename,
          {
            onProgress: (loaded, total) => setState((s) => ({ ...s, progress: { loaded, total } })),
            onUploaded: () => setState((s) => ({ ...s, phase: 'running' })),
            onEvent,
          },
          controller.signal,
        );
        finish(controller);
      } catch (err) {
        finish(controller, err);
      }
    },
    [serverId, app, onEvent, finish],
  );

  /** Deploy an app with `build.type: image`: no upload, the server pulls the image. */
  const pull = useCallback(
    async (image: string) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setState({ ...IDLE, kind: 'deploy', phase: 'running', label: image });
      try {
        await followDeployStream(appPath(serverId, app, '/deploy'), {}, controller.signal, onEvent);
        finish(controller);
      } catch (err) {
        finish(controller, err);
      }
    },
    [serverId, app, onEvent, finish],
  );

  /** POST `body` to `path` and follow the stream it answers with: a rollback, a quick service created or updated. */
  const follow = useCallback(
    async (kind: DeployRunKind, label: string, path: string, body: unknown) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setState({ ...IDLE, kind, phase: 'running', label });
      try {
        await followDeployStream(path, body, controller.signal, onEvent);
        finish(controller);
      } catch (err) {
        finish(controller, err);
      }
    },
    [onEvent, finish],
  );

  const rollback = useCallback((release: string) => follow('rollback', `release ${release}`, appPath(serverId, app, '/rollback'), { release }), [serverId, app, follow]);

  const dismiss = useCallback(() => {
    abort.current?.abort();
    setState(IDLE);
  }, []);

  const busy = state.phase === 'packing' || state.phase === 'uploading' || state.phase === 'running';
  return { state, busy, deploy, pull, rollback, follow, dismiss };
}

/** A failure the docs know: a link to its troubleshooting section. */
function FailureHint({ error, lines }: { error: string | null; lines: DeployLogLine[] }) {
  const hint = deployFailureHint(error, lines);
  if (!hint) return null;
  return (
    <p className="mx-4 mt-2 text-sm">
      <DocsLink to={hint.href}>How to fix: {hint.label}</DocsLink>
    </p>
  );
}

/** The panel for a run: progress, the log, and how it ended. */
export function DeployRunPanel({ state, onDismiss }: { state: DeployRunState; onDismiss: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (box.current && stick.current) box.current.scrollTop = box.current.scrollHeight;
  }, [state.lines]);
  if (state.phase === 'idle') return null;

  const verb = { deploy: 'Deploy', rollback: 'Rollback', create: 'Create', update: 'Update' }[state.kind];
  const percent = state.progress && state.progress.total > 0 ? Math.min(100, Math.round((state.progress.loaded / state.progress.total) * 100)) : 0;
  return (
    <section aria-label={`${verb} log`} className="mb-4 rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm">
        {state.phase === 'success' ? (
          <CheckCircle2 size={15} className="text-emerald-500" />
        ) : state.phase === 'failed' ? (
          state.exit ? <XCircle size={15} className="text-red-500" /> : <TriangleAlert size={15} className="text-amber-500" />
        ) : (
          <Loader2 size={15} className="animate-spin text-muted-foreground" />
        )}
        <span className="font-medium">
          {state.phase === 'packing' && 'Packing files…'}
          {state.phase === 'uploading' && `Uploading ${state.label}… ${percent}%`}
          {state.phase === 'running' &&
            { deploy: 'Deploying…', rollback: `Rolling back to ${state.label}…`, create: `Creating ${state.label}…`, update: `Updating to ${state.label}…` }[state.kind]}
          {state.phase === 'success' &&
            {
              deploy: `Deployed release ${state.outcome?.release ?? ''}`,
              rollback: `Rolled back to release ${state.outcome?.release ?? ''}`,
              create: `Created ${state.label}: release ${state.outcome?.release ?? ''} is running`,
              update: `Updated to ${state.label}: release ${state.outcome?.release ?? ''}`,
            }[state.kind]}
          {state.phase === 'failed' && `${verb} failed`}
        </span>
        {state.exit && state.phase !== 'running' && (
          <span className="text-xs text-muted-foreground">in {(state.exit.durationMs / 1000).toFixed(1)} s</span>
        )}
        <button
          onClick={onDismiss}
          title={state.phase === 'running' ? 'Stop following (the deploy keeps running on the server)' : 'Close'}
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          <X size={15} />
        </button>
      </div>
      {state.phase === 'uploading' && state.progress && (
        <div className="px-4 pt-3">
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatBytes(state.progress.loaded)} of {formatBytes(state.progress.total)}
          </p>
        </div>
      )}
      {state.error && state.phase === 'failed' && (
        <p className="mx-4 mt-3 whitespace-pre-wrap break-words rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{state.error}</p>
      )}
      {state.phase === 'failed' && state.issues && state.issues.length > 0 && (
        <ul className="mx-4 mt-2 list-disc space-y-0.5 pl-5 text-sm text-red-600">
          {state.issues.map((i, n) => (
            <li key={n}>
              {i.path && <span className="font-mono">{i.path}: </span>}
              {i.message}
            </li>
          ))}
        </ul>
      )}
      {state.phase === 'failed' && <FailureHint error={state.error} lines={state.lines} />}
      {state.outcome?.previous && state.phase === 'success' && (
        <p className="mx-4 mt-3 text-xs text-muted-foreground">
          Previously serving <span className="font-mono">{state.outcome.previous}</span> — roll back to it from Releases.
        </p>
      )}
      {(state.phase === 'running' || state.lines.length > 0) && (
        <div
          ref={box}
          data-testid="deploy-log"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="m-4 max-h-80 min-h-[8rem] overflow-auto rounded-md border border-border bg-zinc-950 p-2 font-mono text-xs leading-5 text-zinc-100"
        >
          {/* As the server sent it: masking .env values in the app's own output (a failed health check's log) is bastionctl's job, before it leaves the server */}
          {state.lines.map((l, i) => (
            <div key={i} className={cn('whitespace-pre-wrap break-all', /error|failed/i.test(l.text) && 'text-red-300')}>
              {l.text}
            </div>
          ))}
          {state.phase === 'running' && state.lines.length === 0 && <p className="text-zinc-500">Waiting for output…</p>}
        </div>
      )}
    </section>
  );
}
