import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api.js';
import { Server, Key, Terminal, Clock, AlertTriangle, Activity } from 'lucide-react';
import type {
  Server as ServerType,
  SSHKey,
  SavedCommand,
  CronJob,
  MonitoringOverview,
} from '@smt/shared';
import { StatusDot } from '@/components/monitoring/StatusBadge.js';
import { formatUptime, statusMeta, usageTone } from '@/lib/monitoring.js';
import { cn, relativeTime } from '@/lib/utils.js';

function StatCard({ label, value, icon: Icon, color, sub }: { label: string; value: number | string; icon: React.ElementType; color: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center gap-3">
        <div className={`rounded-md p-2 ${color}`}>
          <Icon size={18} />
        </div>
        <div>
          <p className="text-2xl font-bold">{value}</p>
          <p className="text-sm text-muted-foreground">{label}</p>
        </div>
      </div>
      {sub && <p className="mt-2 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

export default function DashboardPage() {
  const { data: servers } = useQuery<ServerType[]>({ queryKey: ['servers'], queryFn: () => api.get('/servers') });
  const { data: keys } = useQuery<SSHKey[]>({ queryKey: ['ssh-keys'], queryFn: () => api.get('/keys') });
  const { data: commands } = useQuery<SavedCommand[]>({ queryKey: ['saved-commands'], queryFn: () => api.get('/commands') });
  const { data: cronJobs } = useQuery<CronJob[]>({ queryKey: ['cron-jobs'], queryFn: () => api.get('/cron-jobs') });
  const { data: overview } = useQuery<MonitoringOverview>({
    queryKey: ['monitoring-overview'],
    queryFn: () => api.get('/monitoring/overview'),
    refetchInterval: 30_000,
  });

  const summary = overview?.summary;
  const alerts = overview?.alerts ?? [];
  const attention = (overview?.servers ?? [])
    .filter((h) => h.status === 'offline' || h.status === 'error')
    .slice(0, 5);
  const busiest = [...(overview?.servers ?? [])]
    .filter((h) => h.status === 'online')
    .sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0))
    .slice(0, 5);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-1">Dashboard</h1>
      <p className="text-muted-foreground mb-6">Overview of your infrastructure</p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Servers"
          value={servers?.length ?? 0}
          icon={Server}
          color="bg-blue-500/10 text-blue-500"
          sub={summary ? `${summary.online} online · ${summary.offline + summary.error} down` : undefined}
        />
        <StatCard label="SSH Keys" value={keys?.length ?? 0} icon={Key} color="bg-emerald-500/10 text-emerald-500" />
        <StatCard label="Saved Commands" value={commands?.length ?? 0} icon={Terminal} color="bg-purple-500/10 text-purple-500" />
        <StatCard label="Cron Jobs" value={cronJobs?.filter(j => j.enabled).length ?? 0} icon={Clock} color="bg-orange-500/10 text-orange-500" />
      </div>

      {(alerts.length > 0 || attention.length > 0) && (
        <div className="mb-6 rounded-lg border border-orange-500/30 bg-orange-500/5">
          <div className="flex items-center gap-2 border-b border-orange-500/20 p-4">
            <AlertTriangle size={16} className="text-orange-500" />
            <h2 className="font-semibold">Needs attention</h2>
            <Link to="/monitoring" className="ml-auto text-xs text-muted-foreground hover:underline">
              View monitoring →
            </Link>
          </div>
          <div className="divide-y divide-orange-500/10">
            {attention.map((h) => (
              <div key={h.serverId} className="flex items-center gap-3 p-3">
                <StatusDot status={h.status} />
                <Link to={`/servers/${h.serverId}/health`} className="text-sm font-medium hover:underline">
                  {h.serverName}
                </Link>
                <span className={cn('text-xs', statusMeta(h.status).text)}>
                  {statusMeta(h.status).label}
                </span>
                <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">
                  {h.lastError ?? (h.lastCheckedAt ? `checked ${relativeTime(h.lastCheckedAt)}` : '')}
                </span>
              </div>
            ))}
            {alerts.slice(0, 5).map((a) => (
              <div key={a.id} className="flex items-center gap-3 p-3">
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                    a.severity === 'critical' ? 'bg-red-500/10 text-red-500' : 'bg-amber-500/10 text-amber-500',
                  )}
                >
                  {a.severity}
                </span>
                <Link to={`/servers/${a.serverId}/health`} className="shrink-0 text-sm font-medium hover:underline">
                  {a.serverName ?? a.serverId}
                </Link>
                <span className="truncate text-xs text-muted-foreground">{a.message}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {relativeTime(a.openedAt)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Fleet health */}
        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 p-4 border-b border-border">
            <Activity size={16} className="text-muted-foreground" />
            <h2 className="font-semibold">Fleet health</h2>
            <Link to="/monitoring" className="ml-auto text-xs text-muted-foreground hover:underline">
              All servers →
            </Link>
          </div>
          <div className="divide-y divide-border">
            {busiest.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                {servers?.length
                  ? 'No health data yet — the first check runs within a minute.'
                  : 'No servers yet.'}
              </p>
            ) : (
              busiest.map((h) => (
                <div key={h.serverId} className="flex items-center gap-3 p-4">
                  <StatusDot status={h.status} />
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/servers/${h.serverId}/health`}
                      className="text-sm font-medium hover:underline"
                    >
                      {h.serverName}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      up {formatUptime(h.uptimeSeconds)}
                      {h.load1 != null && ` · load ${h.load1.toFixed(2)}`}
                    </p>
                  </div>
                  <div className="w-28 shrink-0">
                    <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
                      <span>CPU</span>
                      <span className="font-mono">
                        {h.cpuPercent != null ? `${Math.round(h.cpuPercent)}%` : '—'}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn('h-full rounded-full', usageTone(h.cpuPercent))}
                        style={{ width: `${Math.min(h.cpuPercent ?? 0, 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Active cron jobs */}
        <div className="rounded-lg border border-border bg-card">
          <div className="p-4 border-b border-border">
            <h2 className="font-semibold">Active Cron Jobs</h2>
          </div>
          <div className="divide-y divide-border">
            {cronJobs?.some(j => j.enabled) === false && (
              <p className="p-4 text-sm text-muted-foreground">No active cron jobs.</p>
            )}
            {cronJobs?.filter(j => j.enabled).slice(0, 5).map((j) => (
              <div key={j.id} className="flex items-center justify-between p-4">
                <div>
                  <p className="text-sm font-medium">{j.name}</p>
                  <p className="text-xs text-muted-foreground font-mono">{j.schedule}</p>
                </div>
                {j.nextRunAt && (
                  <p className="text-xs text-muted-foreground">
                    Next: {new Date(j.nextRunAt).toLocaleString()}
                  </p>
                )}
              </div>
            )) ?? <p className="p-4 text-sm text-muted-foreground">No active cron jobs.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
