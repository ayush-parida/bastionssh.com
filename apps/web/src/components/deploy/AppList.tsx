import type { DeployAppSummary, DeployContainer } from '@smt/shared';
import { Lock, Plus, Rocket, TriangleAlert } from 'lucide-react';
import { HEALTH_STYLE, STATE_STYLE } from '@/lib/docker.js';
import type { DeployAppRow } from '@/lib/deploy.js';
import { cn, formatBytes } from '@/lib/utils.js';

/** The live container's state, with its health check when the image has one. */
export function HealthBadge({ app }: { app: Pick<DeployAppSummary, 'container' | 'currentRelease' | 'configError'> }) {
  const c: DeployContainer | null = app.container;
  if (app.configError) return <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-xs text-red-600">Config error</span>;
  if (!app.currentRelease) return <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Not deployed</span>;
  if (!c) return <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-xs text-red-600">No container</span>;
  const health = c.health === 'healthy' || c.health === 'unhealthy' || c.health === 'starting' ? c.health : null;
  return (
    <span className="flex flex-wrap gap-1">
      <span className={cn('rounded px-1.5 py-0.5 text-xs', STATE_STYLE[c.state as keyof typeof STATE_STYLE] ?? 'bg-muted text-muted-foreground')}>
        {c.state}
      </span>
      {health && <span className={cn('rounded px-1.5 py-0.5 text-xs', HEALTH_STYLE[health])}>{health}</span>}
    </span>
  );
}

/** Days until a certificate expires, as the list shows it. */
function certText(row: DeployAppRow): { text: string; warn: boolean } {
  const cert = row.certificate;
  if (!cert) return { text: '—', warn: false };
  if (cert.error) return { text: 'Error', warn: true };
  if (!cert.expiresAt) return { text: 'Pending', warn: false };
  const days = Math.floor((new Date(cert.expiresAt).getTime() - Date.now()) / 86_400_000);
  return { text: days < 0 ? 'Expired' : `${days} d`, warn: days < 14 };
}

/**
 * The server's apps (spec §7): domains, health, current release, certificate
 * and memory/CPU. Read from the server on every load; a row opens the app.
 */
export default function AppList({
  apps,
  onOpen,
  onNew,
}: {
  apps: DeployAppRow[];
  onOpen: (app: string) => void;
  /** Shown to members who manage deployments on this server. */
  onNew?: () => void;
}) {
  return (
    <section aria-label="Apps" className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Rocket size={16} className="text-primary" />
        <h2 className="font-semibold">Apps</h2>
        <span className="text-xs text-muted-foreground">{apps.length}</span>
        {onNew && (
          <button onClick={onNew} className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm hover:bg-muted">
            <Plus size={14} /> New app
          </button>
        )}
      </div>
      {apps.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          No apps yet.{onNew ? ' Create one with its bastion.yml, then deploy a build to it.' : ''}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">App</th>
                <th className="px-4 py-2 font-medium">Domains</th>
                <th className="px-4 py-2 font-medium">Health</th>
                <th className="px-4 py-2 font-medium">Release</th>
                <th className="px-4 py-2 font-medium">Certificate</th>
                <th className="px-4 py-2 font-medium">Memory / CPU</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => {
                const cert = certText(app);
                return (
                  <tr
                    key={app.name}
                    onClick={() => onOpen(app.name)}
                    className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40"
                  >
                    <td className="px-4 py-2.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(app.name);
                        }}
                        className="flex items-center gap-1.5 font-mono font-medium hover:underline">
                        {app.name}
                        {app.locked && (
                          <span title="A deploy is running" className="text-amber-500">
                            <Lock size={12} />
                          </span>
                        )}
                      </button>
                      {app.buildType && <span className="text-xs text-muted-foreground">{app.buildType}</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      {app.configError ? (
                        <span className="flex items-start gap-1 text-xs text-red-600" title={app.configError}>
                          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                          <span className="line-clamp-2">{app.configError}</span>
                        </span>
                      ) : (
                        <span className="text-xs">{app.domains.join(', ') || '—'}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <HealthBadge app={app} />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">{app.currentRelease ?? '—'}</td>
                    <td className={cn('px-4 py-2.5 text-xs', cert.warn && 'text-amber-600')}>{cert.text}</td>
                    <td className="px-4 py-2.5 text-xs">
                      {app.usage
                        ? `${formatBytes(app.usage.memoryBytes, 0)}${app.usage.memoryLimitBytes ? ` / ${formatBytes(app.usage.memoryLimitBytes, 0)}` : ''} · ${app.usage.cpuPercent.toFixed(1)}%`
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
