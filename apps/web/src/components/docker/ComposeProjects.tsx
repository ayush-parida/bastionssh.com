import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DockerComposeProject, DockerComposeVerb, DockerPermissions } from '@smt/shared';
import { ArrowDownToLine, Layers, Lock, Play, RotateCw, ScrollText, Square, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { HEALTH_STYLE, STATE_STYLE, dockerKeys, dockerPath, uptimeText } from '@/lib/docker.js';
import { DockerProblem, problemOf } from './DetectDocker.js';
import ComposeAction from './ComposeAction.js';
import ComposeLogs from './ComposeLogs.js';

/**
 * Keyed under the container list, so the engine events that refresh it
 * (lib/docker.ts `useDockerEvents`) refresh the projects too.
 */
const composeKey = (serverId: string) => [...dockerKeys.containers(serverId), 'compose'] as const;

const PROJECT_STATE: Record<DockerComposeProject['state'], string> = {
  running: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  partial: 'bg-amber-500/10 text-amber-600',
  stopped: 'bg-muted text-muted-foreground',
};

const ACTIONS: { verb: DockerComposeVerb; label: string; icon: typeof Play }[] = [
  { verb: 'up', label: 'Up', icon: Play },
  { verb: 'restart', label: 'Restart', icon: RotateCw },
  { verb: 'pull', label: 'Pull', icon: ArrowDownToLine },
  { verb: 'down', label: 'Down', icon: Square },
];

/**
 * Compose projects on a server, discovered from their containers' labels:
 * services with their containers and state, `up`/`restart`/`pull`/`down`
 * for operators and up, and merged logs.
 */
export default function ComposeProjects({ serverId, permissions }: { serverId: string; permissions: DockerPermissions }) {
  const [action, setAction] = useState<{ project: DockerComposeProject; verb: DockerComposeVerb } | null>(null);
  const [logsOf, setLogsOf] = useState<DockerComposeProject | null>(null);

  const projects = useQuery<DockerComposeProject[]>({
    queryKey: composeKey(serverId),
    queryFn: () => api.get(dockerPath(serverId, '/compose')),
  });

  if (projects.error) return <DockerProblem {...problemOf(projects.error)} onRetry={() => projects.refetch()} />;
  if (!projects.data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div>
      {projects.data.length === 0 ? (
        <div className="flex flex-col items-center py-12 text-center text-muted-foreground">
          <Layers size={32} className="mb-2 opacity-30" />
          <p className="text-sm">No compose projects.</p>
          <p className="mt-1 max-w-md text-xs">
            Projects are found from the labels Docker Compose puts on containers. A project that was taken down has no
            containers left, so it shows up again once it is started on the server.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {projects.data.map((p) => (
            <section key={p.name} className="rounded-lg border border-border bg-card">
              <header className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium">
                    {p.name}
                    <span className={cn('rounded px-1.5 py-0.5 text-xs font-normal', PROJECT_STATE[p.state])}>
                      {p.running}/{p.total} running
                    </span>
                  </p>
                  {p.workingDir && (
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={p.configFiles.join('\n')}>
                      {p.workingDir}
                    </p>
                  )}
                  {p.unmanageable && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-amber-600">
                      <TriangleAlert size={12} /> Actions unavailable: {p.unmanageable}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {permissions.inspect ? (
                    <button
                      onClick={() => setLogsOf(p)}
                      className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                    >
                      <ScrollText size={12} /> Logs
                    </button>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground" title="Logs need the operator role or higher">
                      <Lock size={11} /> Logs
                    </span>
                  )}
                  {permissions.pull &&
                    ACTIONS.map(({ verb, label, icon: Icon }) => (
                      <button
                        key={verb}
                        onClick={() => setAction({ project: p, verb })}
                        disabled={!!p.unmanageable}
                        title={p.unmanageable ?? `docker compose ${verb}`}
                        className={cn(
                          'flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40',
                          verb === 'down' && 'text-red-600',
                        )}
                      >
                        <Icon size={12} /> {label}
                      </button>
                    ))}
                </div>
              </header>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-border">
                  {p.services.map((s) =>
                    s.containers.map((c, i) => (
                      <tr key={c.id}>
                        <td className="w-40 px-4 py-1.5 align-top">{i === 0 && <span className="font-medium">{s.name}</span>}</td>
                        <td className="px-4 py-1.5">
                          <span className="font-mono text-xs">{c.name}</span>
                        </td>
                        <td className="max-w-[14rem] truncate px-4 py-1.5 font-mono text-xs text-muted-foreground" title={c.image}>
                          {c.image}
                        </td>
                        <td className="px-4 py-1.5">
                          <span className="flex flex-wrap items-center gap-1">
                            <span className={cn('rounded px-1.5 py-0.5 text-xs', STATE_STYLE[c.state])}>{c.state}</span>
                            {c.health && <span className={cn('rounded px-1.5 py-0.5 text-xs', HEALTH_STYLE[c.health])}>{c.health}</span>}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-1.5 text-xs text-muted-foreground">{uptimeText(c.status)}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      )}

      {action && (
        <ComposeAction
          serverId={serverId}
          project={action.project}
          verb={action.verb}
          onClose={() => {
            setAction(null);
            projects.refetch();
          }}
        />
      )}
      {logsOf && <ComposeLogs serverId={serverId} project={logsOf} onClose={() => setLogsOf(null)} />}
    </div>
  );
}
