import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DockerComposeProject, DockerComposeServiceVerb, DockerComposeVerb, DockerLogLine, DockerStreamEvent } from '@smt/shared';
import { CheckCircle2, Loader2, TriangleAlert, X, XCircle } from 'lucide-react';
import { api } from '@/lib/api.js';
import { readSSE } from '@/lib/sse.js';
import { cn } from '@/lib/utils.js';
import { dockerKeys, dockerPath } from '@/lib/docker.js';

/** What each verb runs, as the user would type it. */
export const COMPOSE_COMMAND: Record<DockerComposeVerb, string> = {
  up: 'up --detach',
  down: 'down',
  pull: 'pull',
  restart: 'restart',
};

/** What each verb runs on one service, before the service name. */
export const COMPOSE_SERVICE_COMMAND: Record<DockerComposeServiceVerb, string> = {
  up: 'up --detach --no-deps',
  restart: 'restart',
  pull: 'pull',
  stop: 'stop',
};

const EXPLAIN: Record<DockerComposeVerb, string> = {
  up: 'Creates and starts every service of the project, recreating containers whose configuration or image changed.',
  down: 'Stops and removes the project’s containers and networks. Volumes are kept. The project disappears from this list until it is started again on the server.',
  pull: 'Pulls the images of every service. Running containers keep their current image until the next “up”.',
  restart: 'Restarts every service’s containers. Configuration changes are not applied — use “up” for that.',
};

const EXPLAIN_SERVICE: Record<DockerComposeServiceVerb, string> = {
  up: 'Recreates this service’s containers if its image or configuration changed — for example after uploading a new image under the same tag — and starts them. Services it depends on are left alone.',
  restart: 'Restarts this service’s containers with their current image and configuration. A new image is not picked up — use “up” for that.',
  pull: 'Pulls this service’s image from its registry. Running containers keep their current image until the next “up”.',
  stop: 'Stops this service’s containers. They are kept and start again with “up” or “restart”.',
};

const MAX_LINES = 5_000;

export type ComposePhase = 'confirm' | 'running' | 'done' | 'error';

/** The command line shown to people, as they would type it. */
export function composeCommandLine(project: string, verb: DockerComposeVerb | DockerComposeServiceVerb, service?: string): string {
  return service === undefined
    ? `docker compose -p ${project} ${COMPOSE_COMMAND[verb as DockerComposeVerb]}`
    : `docker compose -p ${project} ${COMPOSE_SERVICE_COMMAND[verb as DockerComposeServiceVerb]} ${service}`;
}

/**
 * Run a compose action and collect its output as it arrives. `run()` resolves
 * with whether it finished with exit code 0. Leaving the page stops reading,
 * not the action (it keeps running on the server and is audited when it ends).
 */
export function useComposeRun(serverId: string) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<ComposePhase>('confirm');
  const [lines, setLines] = useState<DockerLogLine[]>([]);
  const [exit, setExit] = useState<Extract<DockerStreamEvent, { type: 'exit' }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  async function run(project: string, verb: DockerComposeVerb | DockerComposeServiceVerb, service?: string): Promise<boolean> {
    const controller = new AbortController();
    abort.current = controller;
    setPhase('running');
    setLines([]);
    setExit(null);
    setError(null);
    const path =
      service === undefined
        ? `/compose/${encodeURIComponent(project)}/${verb}`
        : `/compose/${encodeURIComponent(project)}/services/${encodeURIComponent(service)}/${verb}`;
    try {
      const res = await api.stream(dockerPath(serverId, path), {}, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
      for await (const event of readSSE<DockerStreamEvent>(res)) {
        if (event.type === 'logs') {
          setLines((prev) => {
            const next = prev.concat(event.lines);
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        } else if (event.type === 'exit') {
          setExit(event);
          setPhase(event.exitCode === 0 ? 'done' : 'error');
          return event.exitCode === 0;
        } else if (event.type === 'error') {
          setError(event.error);
          setPhase('error');
          return false;
        }
      }
      if (!controller.signal.aborted) {
        setError('The connection ended before the action finished.');
        setPhase('error');
      }
      return false;
    } catch (err) {
      if (controller.signal.aborted) return false;
      setError((err as Error).message);
      setPhase('error');
      return false;
    } finally {
      // Containers changed (or may have): refresh the lists and the project view
      qc.invalidateQueries({ queryKey: dockerKeys.containers(serverId) });
      qc.invalidateQueries({ queryKey: dockerKeys.images(serverId) });
    }
  }

  return { phase, lines, exit, error, run };
}

/** The CLI's output as it arrives, and how the run ended. */
export function ComposeOutput({
  command,
  run,
  footer,
}: {
  command: string;
  run: Pick<ReturnType<typeof useComposeRun>, 'phase' | 'lines' | 'exit' | 'error'>;
  footer?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { phase, lines, exit, error } = run;
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);
  return (
    <>
      <div
        ref={box}
        className="min-h-[12rem] flex-1 overflow-auto rounded-md border border-border bg-zinc-950 p-2 font-mono text-xs leading-5 text-zinc-100"
      >
        <div className="select-none text-zinc-500">$ {command}</div>
        {lines.map((l, i) => (
          <div key={i} className={cn('whitespace-pre-wrap break-all', l.stream === 'stderr' && 'text-zinc-300')}>
            {l.text}
          </div>
        ))}
        {phase === 'running' && lines.length === 0 && <p className="text-zinc-500">Waiting for output…</p>}
      </div>
      <div className="mt-3 flex items-center gap-2 text-sm">
        {phase === 'running' && (
          <>
            <Loader2 size={14} className="animate-spin text-muted-foreground" /> Running…
          </>
        )}
        {phase === 'done' && (
          <>
            <CheckCircle2 size={14} className="text-emerald-500" /> Finished
            {exit && <span className="text-xs text-muted-foreground">in {(exit.durationMs / 1000).toFixed(1)} s</span>}
          </>
        )}
        {phase === 'error' && (
          <span className="flex min-w-0 items-start gap-1.5">
            {exit ? <XCircle size={14} className="mt-0.5 shrink-0 text-red-500" /> : <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-500" />}
            <span className="break-words">
              {error ??
                (exit?.timedOut
                  ? 'Timed out; the command was stopped.'
                  : exit?.exitCode === null
                    ? 'The command was cut off before it finished.'
                    : `Failed with exit code ${exit?.exitCode}.`)}
            </span>
          </span>
        )}
        {footer}
      </div>
    </>
  );
}

/**
 * Confirm a compose action on a project — or on one of its services — then
 * run it and show the CLI's output as it arrives. Closing the dialog while it
 * runs does not stop the action on the server (it is audited when it ends).
 */
export default function ComposeAction({
  serverId,
  project,
  verb,
  service,
  onClose,
}: {
  serverId: string;
  project: DockerComposeProject;
  verb: DockerComposeVerb | DockerComposeServiceVerb;
  /** One service of the project; the whole project when left out. */
  service?: string;
  onClose: () => void;
}) {
  const action = useComposeRun(serverId);
  const command = composeCommandLine(project.name, verb, service);
  const destructive = service === undefined ? verb === 'down' : verb === 'stop';
  const title =
    service === undefined
      ? `${verb === 'up' ? 'Start' : verb === 'down' ? 'Take down' : verb === 'pull' ? 'Pull images for' : 'Restart'} `
      : `${verb === 'up' ? 'Update' : verb === 'pull' ? 'Pull the image of' : verb === 'stop' ? 'Stop' : 'Restart'} `;
  const subject = service === undefined ? project.name : `${service}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => e.target === e.currentTarget && action.phase !== 'running' && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={service === undefined ? `Compose ${verb} ${project.name}` : `Compose ${verb} ${service} in ${project.name}`}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold">
              {title}
              <span className="font-mono">{subject}</span>
              {service !== undefined && (
                <span className="text-sm font-normal text-muted-foreground">
                  {' '}
                  in <span className="font-mono">{project.name}</span>
                </span>
              )}
            </p>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{command}</p>
          </div>
          <button
            onClick={onClose}
            title={action.phase === 'running' ? 'Close (the action keeps running)' : 'Close'}
            className="text-muted-foreground hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {action.phase === 'confirm' ? (
          <div className="space-y-3 px-5 py-4 text-sm">
            <p>{service === undefined ? EXPLAIN[verb as DockerComposeVerb] : EXPLAIN_SERVICE[verb as DockerComposeServiceVerb]}</p>
            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
              <p>
                <span className="text-muted-foreground">Runs in </span>
                <span className="break-all font-mono">{project.workingDir}</span>
              </p>
              <p className="mt-1">
                <span className="text-muted-foreground">Files </span>
                <span className="break-all font-mono">{project.configFiles.join(', ')}</span>
              </p>
              {service === undefined && (
                <p className="mt-1 text-muted-foreground">
                  {project.services.length} service{project.services.length === 1 ? '' : 's'}: {project.services.map((s) => s.name).join(', ')}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
                Cancel
              </button>
              <button
                onClick={() => void action.run(project.name, verb, service)}
                autoFocus
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium text-white',
                  destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-primary hover:opacity-90',
                )}
              >
                {service === undefined && verb === 'down' ? `Take down ${project.name}` : `Run ${verb}`}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col p-5">
            <ComposeOutput
              command={command}
              run={action}
              footer={
                <button onClick={onClose} className="ml-auto rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
                  Close
                </button>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
