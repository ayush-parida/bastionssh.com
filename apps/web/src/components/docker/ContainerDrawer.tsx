import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DockerContainer, DockerPermissions, DockerTop } from '@smt/shared';
import { Lock, X } from 'lucide-react';
import { api } from '@/lib/api.js';
import { cn, relativeTime } from '@/lib/utils.js';
import { dockerKeys, dockerPath, formatPorts, shortId } from '@/lib/docker.js';
import { StateBadge } from './ContainersTable.js';
import ContainerLogs from './ContainerLogs.js';
import ContainerStats from './ContainerStats.js';
import JsonViewer from './JsonViewer.js';

type Tab = 'overview' | 'logs' | 'stats' | 'env' | 'inspect';

const TABS: { id: Tab; label: string; needs: keyof DockerPermissions }[] = [
  { id: 'overview', label: 'Overview', needs: 'view' },
  { id: 'logs', label: 'Logs', needs: 'inspect' },
  { id: 'stats', label: 'Stats', needs: 'inspect' },
  { id: 'env', label: 'Environment', needs: 'inspect' },
  { id: 'inspect', label: 'Inspect', needs: 'inspect' },
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

type Inspect = { Config?: { Env?: string[] | null; Labels?: Record<string, string> | null } };

/**
 * One container: facts, live logs and stats, its (redacted) environment and
 * the full inspect payload. Tabs past the overview need the `inspect`
 * permission — logs routinely carry tokens and PII. Later phases add actions
 * and "Open shell" through `actions`.
 */
export default function ContainerDrawer({
  serverId,
  container,
  permissions,
  onClose,
  actions,
}: {
  serverId: string;
  container: DockerContainer;
  permissions: DockerPermissions;
  onClose: () => void;
  actions?: React.ReactNode;
}) {
  const [tab, setTab] = useState<Tab>('overview');
  const canInspect = permissions.inspect;

  const inspect = useQuery<Inspect>({
    queryKey: dockerKeys.inspect(serverId, container.id),
    queryFn: () => api.get(dockerPath(serverId, `/containers/${container.id}`)),
    enabled: canInspect && (tab === 'env' || tab === 'inspect'),
  });
  const top = useQuery<DockerTop>({
    queryKey: dockerKeys.top(serverId, container.id),
    queryFn: () => api.get(dockerPath(serverId, `/containers/${container.id}/top`)),
    enabled: canInspect && tab === 'overview' && container.state === 'running',
    refetchInterval: 10_000,
  });

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Container ${container.name}`}
        className="flex h-full w-full max-w-3xl flex-col border-l border-border bg-card shadow-xl"
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold">{container.name}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {shortId(container.id)} · {container.image}
            </p>
            <div className="mt-2">
              <StateBadge container={container} />
            </div>
          </div>
          {actions}
          <button onClick={onClose} title="Close" className="text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        <div className="flex gap-1 border-b border-border px-5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              disabled={!permissions[t.needs]}
              title={permissions[t.needs] ? undefined : 'Needs the operator role or higher'}
              className={cn(
                'flex items-center gap-1 border-b-2 px-3 py-2 text-sm disabled:opacity-40',
                tab === t.id ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {!permissions[t.needs] && <Lock size={11} />}
              {t.label}
            </button>
          ))}
        </div>

        <div className={cn('min-h-0 flex-1 p-5', tab === 'logs' ? 'flex flex-col' : 'overflow-y-auto')}>
          {tab === 'overview' && (
            <div>
              <Row label="State">{container.status}</Row>
              <Row label="Created">{relativeTime(container.createdAt)}</Row>
              <Row label="Image">
                <span className="font-mono text-xs">{container.image}</span>
              </Row>
              <Row label="Command">
                <span className="font-mono text-xs">{container.command || '—'}</span>
              </Row>
              <Row label="Ports">
                <span className="font-mono text-xs">{formatPorts(container).join(', ') || '—'}</span>
              </Row>
              {container.composeProject && (
                <Row label="Compose">
                  {container.composeProject}
                  {container.composeService && ` / ${container.composeService}`}
                </Row>
              )}
              {Object.keys(container.labels).length > 0 && (
                <Row label="Labels">
                  <div className="space-y-0.5 font-mono text-xs">
                    {Object.entries(container.labels).map(([k, v]) => (
                      <div key={k} className="break-all">
                        <span className="text-muted-foreground">{k}=</span>
                        {v}
                      </div>
                    ))}
                  </div>
                </Row>
              )}
              {!canInspect && (
                <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Lock size={12} /> Logs, stats and details need the operator role or higher — logs often contain secrets.
                </p>
              )}
              {canInspect && container.state === 'running' && top.data && (
                <div className="mt-4">
                  <p className="mb-2 text-sm font-medium">Processes</p>
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full font-mono text-xs">
                      <thead className="border-b border-border text-left text-muted-foreground">
                        <tr>
                          {top.data.titles.map((t) => (
                            <th key={t} className="px-2 py-1 font-medium">
                              {t}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {top.data.processes.map((p, i) => (
                          <tr key={i} className="border-b border-border last:border-0">
                            {p.map((cell, j) => (
                              <td key={j} className="whitespace-nowrap px-2 py-1">
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
          {tab === 'logs' && <ContainerLogs serverId={serverId} containerId={container.id} name={container.name} />}
          {tab === 'stats' &&
            (container.state === 'running' ? (
              <ContainerStats serverId={serverId} containerId={container.id} />
            ) : (
              <p className="text-sm text-muted-foreground">The container is not running.</p>
            ))}
          {tab === 'env' &&
            (inspect.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : inspect.error ? (
              <p className="text-sm text-red-600">{(inspect.error as Error).message}</p>
            ) : (
              <div>
                <p className="mb-3 text-xs text-muted-foreground">
                  Values are hidden: environment variables are where containers keep their secrets.
                </p>
                <div className="space-y-0.5 rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
                  {(inspect.data?.Config?.Env ?? []).length === 0 && <p className="text-muted-foreground">No variables.</p>}
                  {(inspect.data?.Config?.Env ?? []).map((e, i) => {
                    const eq = e.indexOf('=');
                    return (
                      <div key={i} className="break-all">
                        {eq === -1 ? e : (
                          <>
                            {e.slice(0, eq)}
                            <span className="text-muted-foreground">{e.slice(eq)}</span>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          {tab === 'inspect' &&
            (inspect.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : inspect.error ? (
              <p className="text-sm text-red-600">{(inspect.error as Error).message}</p>
            ) : (
              <JsonViewer value={inspect.data} />
            ))}
        </div>
      </aside>
    </div>
  );
}
