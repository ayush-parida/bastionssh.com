import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api.js';
import type { MonitoringOverview, ServerAlert, ServerHealthWithServer } from '@smt/shared';
import { useHasRole } from '@/store/auth.js';
import { cn, relativeTime } from '@/lib/utils.js';
import { formatUptime, statusMeta, usageTone } from '@/lib/monitoring.js';
import StatusBadge, { UsageBar } from '@/components/monitoring/StatusBadge.js';
import Sparkline from '@/components/charts/Sparkline.js';
import {
  Activity,
  AlertTriangle,
  BellOff,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  RefreshCw,
  ServerCrash,
} from 'lucide-react';
import { toast } from 'sonner';

const ALERT_LABEL: Record<ServerAlert['type'], string> = {
  offline: 'Unreachable',
  cpu_high: 'High CPU',
  memory_high: 'High memory',
  disk_high: 'Disk filling up',
  load_high: 'High load',
};

function SummaryTile({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
  tone: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className={cn('rounded-md p-2', tone)}>
          <Icon size={18} />
        </div>
        <div>
          <p className="text-2xl font-bold leading-tight">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </div>
    </div>
  );
}

function ServerCard({
  health,
  onCheck,
  checking,
  canCheck,
}: {
  health: ServerHealthWithServer;
  onCheck: (id: string) => void;
  checking: boolean;
  canCheck: boolean;
}) {
  const meta = statusMeta(health.status);
  const offline = health.status !== 'online';

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            to={`/servers/${health.serverId}/health`}
            className="flex items-center gap-1.5 font-medium hover:underline"
          >
            <span className="truncate">{health.serverName}</span>
            <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
          </Link>
          <p className="truncate text-xs text-muted-foreground">
            {health.username}@{health.host}:{health.port}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {canCheck && (
            <button
              onClick={() => onCheck(health.serverId)}
              disabled={checking}
              title="Check now"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw size={14} className={checking ? 'animate-spin' : undefined} />
            </button>
          )}
          <StatusBadge status={health.status} />
        </div>
      </div>

      {offline ? (
        <div className="rounded-md bg-muted/50 p-3 text-xs">
          <p className={cn('font-medium', meta.text)}>
            {health.status === 'paused'
              ? 'Monitoring is turned off for this server.'
              : health.status === 'unknown'
                ? 'Waiting for the first health check.'
                : (health.lastError ?? 'Unreachable')}
          </p>
          {health.lastOnlineAt && (
            <p className="mt-1 text-muted-foreground">
              Last seen online {relativeTime(health.lastOnlineAt)}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <UsageBar label="CPU" percent={health.cpuPercent} tone={usageTone(health.cpuPercent)} />
            <UsageBar label="Memory" percent={health.memPercent} tone={usageTone(health.memPercent)} />
            <UsageBar label="Disk" percent={health.diskPercent} tone={usageTone(health.diskPercent)} />
          </div>
          {health.cpuTrend && health.cpuTrend.length > 1 && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground">CPU 3h</span>
              <Sparkline values={health.cpuTrend} max={100} className="text-primary" width={160} />
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span>Up {formatUptime(health.uptimeSeconds)}</span>
            {health.load1 != null && (
              <span>
                Load {health.load1.toFixed(2)}
                {health.cpuCores ? ` / ${health.cpuCores} cores` : ''}
              </span>
            )}
            {health.latencyMs != null && <span>{Math.round(health.latencyMs)} ms</span>}
            {health.osName && <span className="truncate">{health.osName}</span>}
          </div>
        </>
      )}

      {health.lastCheckedAt && (
        <p className="mt-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
          Checked {relativeTime(health.lastCheckedAt)}
        </p>
      )}
    </div>
  );
}

export default function MonitoringPage() {
  const qc = useQueryClient();
  const canCheck = useHasRole('operator');

  const { data, isLoading } = useQuery<MonitoringOverview>({
    queryKey: ['monitoring-overview'],
    queryFn: () => api.get('/monitoring/overview'),
    // Poll a little faster than the server sweeps so the page never looks stale.
    refetchInterval: 20_000,
  });

  const checkMutation = useMutation({
    mutationFn: (serverId: string) => api.post(`/monitoring/servers/${serverId}/check`),
    onSuccess: (_result, serverId) => {
      qc.invalidateQueries({ queryKey: ['monitoring-overview'] });
      qc.invalidateQueries({ queryKey: ['server-health', serverId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const ackMutation = useMutation({
    mutationFn: (alertId: string) => api.post(`/monitoring/alerts/${alertId}/acknowledge`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitoring-overview'] });
      toast.success('Alert acknowledged');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const summary = data?.summary;
  const alerts = data?.alerts ?? [];

  return (
    <div className="p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-2xl font-bold">Monitoring</h1>
          <p className="text-sm text-muted-foreground">
            Agentless health checks over SSH
            {data ? ` · every ${data.intervalSeconds}s` : ''}
          </p>
        </div>
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ['monitoring-overview'] })}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryTile
          label="Online"
          value={summary?.online ?? 0}
          icon={CheckCircle2}
          tone="bg-emerald-500/10 text-emerald-500"
        />
        <SummaryTile
          label="Offline"
          value={summary?.offline ?? 0}
          icon={ServerCrash}
          tone="bg-red-500/10 text-red-500"
        />
        <SummaryTile
          label="Check errors"
          value={summary?.error ?? 0}
          icon={CircleSlash}
          tone="bg-amber-500/10 text-amber-500"
        />
        <SummaryTile
          label="Active alerts"
          value={summary?.activeAlerts ?? 0}
          icon={AlertTriangle}
          tone="bg-orange-500/10 text-orange-500"
        />
      </div>

      {alerts.length > 0 && (
        <div className="mb-6 overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border p-4">
            <AlertTriangle size={16} className="text-orange-500" />
            <h2 className="font-semibold">Active alerts</h2>
            <span className="text-xs text-muted-foreground">({alerts.length})</span>
          </div>
          <div className="divide-y divide-border">
            {alerts.map((alert) => (
              <div key={alert.id} className="flex items-center gap-3 p-4">
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                    alert.severity === 'critical'
                      ? 'bg-red-500/10 text-red-500'
                      : 'bg-amber-500/10 text-amber-500',
                  )}
                >
                  {alert.severity}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    <Link to={`/servers/${alert.serverId}/health`} className="hover:underline">
                      {alert.serverName ?? alert.serverId}
                    </Link>
                    <span className="text-muted-foreground"> · {ALERT_LABEL[alert.type]}</span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{alert.message}</p>
                </div>
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                  since {relativeTime(alert.openedAt)}
                </span>
                {alert.acknowledgedAt ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <BellOff size={12} />
                    acked
                  </span>
                ) : (
                  canCheck && (
                    <button
                      onClick={() => ackMutation.mutate(alert.id)}
                      className="shrink-0 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-muted"
                    >
                      Acknowledge
                    </button>
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading health…</p>
      ) : data && data.servers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <Activity size={28} className="mx-auto mb-3 text-muted-foreground" />
          <p className="mb-1 font-medium">Nothing to monitor yet</p>
          <p className="text-sm text-muted-foreground">
            Add a server and its health will show up here after the next check.
          </p>
          <Link
            to="/servers"
            className="mt-4 inline-block rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            Add a server
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data?.servers.map((health) => (
            <ServerCard
              key={health.serverId}
              health={health}
              canCheck={canCheck}
              checking={checkMutation.isPending && checkMutation.variables === health.serverId}
              onCheck={(id) => checkMutation.mutate(id)}
            />
          ))}
        </div>
      )}

      {summary && summary.paused + summary.unknown > 0 && (
        <p className="mt-4 text-xs text-muted-foreground">
          {summary.unknown > 0 && `${summary.unknown} server(s) awaiting their first check. `}
          {summary.paused > 0 && `${summary.paused} server(s) have monitoring paused.`}
        </p>
      )}
    </div>
  );
}
