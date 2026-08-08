import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '@/lib/api.js';
import type {
  MetricRange,
  MetricSeriesResponse,
  ServerHealthDetail,
  ServerMetric,
} from '@smt/shared';
import { METRIC_RANGES } from '@smt/shared';
import { useHasRole } from '@/store/auth.js';
import { cn, relativeTime } from '@/lib/utils.js';
import { CHART_COLORS, formatKb, formatUptime, usageTone } from '@/lib/monitoring.js';
import StatusBadge, { UsageBar } from '@/components/monitoring/StatusBadge.js';
import MetricChart, { type ChartPoint } from '@/components/charts/MetricChart.js';
import {
  ArrowLeft,
  FolderOpen,
  HardDrive,
  Pause,
  Play,
  RefreshCw,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { toast } from 'sonner';

/** Build a series, mapping failed checks to `null` so outages show as gaps. */
function seriesFrom(samples: ServerMetric[], pick: (m: ServerMetric) => number | undefined): ChartPoint[] {
  return samples.map((m) => ({
    t: m.collectedAt,
    v: m.status === 'online' ? (pick(m) ?? null) : null,
  }));
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-medium">{value}</p>
    </div>
  );
}

export default function ServerHealthPage() {
  const { id: serverId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canCheck = useHasRole('operator');
  const canConfigure = useHasRole('admin');
  const [range, setRange] = useState<MetricRange>('24h');

  const { data, isLoading } = useQuery<ServerHealthDetail>({
    queryKey: ['server-health', serverId],
    queryFn: () => api.get(`/monitoring/servers/${serverId}`),
    refetchInterval: 30_000,
    enabled: !!serverId,
  });

  const { data: metrics } = useQuery<MetricSeriesResponse>({
    queryKey: ['server-metrics', serverId, range],
    queryFn: () => api.get(`/monitoring/servers/${serverId}/metrics?range=${range}`),
    refetchInterval: 60_000,
    enabled: !!serverId,
  });

  const checkMutation = useMutation({
    mutationFn: () => api.post(`/monitoring/servers/${serverId}/check`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['server-health', serverId] });
      qc.invalidateQueries({ queryKey: ['server-metrics', serverId] });
      qc.invalidateQueries({ queryKey: ['monitoring-overview'] });
      toast.success('Health check complete');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.patch(`/monitoring/servers/${serverId}`, { enabled }),
    onSuccess: (_r, enabled) => {
      qc.invalidateQueries({ queryKey: ['server-health', serverId] });
      qc.invalidateQueries({ queryKey: ['monitoring-overview'] });
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast.success(enabled ? 'Monitoring resumed' : 'Monitoring paused');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!data) return <div className="p-6 text-sm text-muted-foreground">Server not found.</div>;

  const { health, latest, alerts } = data;
  const samples = metrics?.samples ?? [];
  const openAlerts = alerts.filter((a) => !a.resolvedAt);

  return (
    <div className="p-6">
      <button
        onClick={() => navigate('/monitoring')}
        className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={14} />
        Back to monitoring
      </button>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-3">
            <h1 className="text-2xl font-bold">{health.serverName}</h1>
            <StatusBadge status={health.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {health.username}@{health.host}:{health.port}
            {health.hostname && health.hostname !== health.serverName && ` · ${health.hostname}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/servers/${serverId}/terminal`}
            className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            <TerminalIcon size={14} />
            Terminal
          </Link>
          <Link
            to={`/servers/${serverId}/files`}
            className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            <FolderOpen size={14} />
            Files
          </Link>
          {canConfigure && (
            <button
              onClick={() => toggleMutation.mutate(!health.monitoringEnabled)}
              disabled={toggleMutation.isPending}
              className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted disabled:opacity-50"
            >
              {health.monitoringEnabled ? <Pause size={14} /> : <Play size={14} />}
              {health.monitoringEnabled ? 'Pause checks' : 'Resume checks'}
            </button>
          )}
          {canCheck && (
            <button
              onClick={() => checkMutation.mutate()}
              disabled={checkMutation.isPending}
              className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <RefreshCw size={14} className={checkMutation.isPending ? 'animate-spin' : undefined} />
              Check now
            </button>
          )}
        </div>
      </div>

      {health.status !== 'online' && health.lastError && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/5 p-4">
          <p className="text-sm font-medium text-red-500">Last check failed</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{health.lastError}</p>
          {health.lastOnlineAt && (
            <p className="mt-2 text-xs text-muted-foreground">
              Last online {relativeTime(health.lastOnlineAt)} · {health.consecutiveFailures} consecutive
              failure(s)
            </p>
          )}
        </div>
      )}

      {openAlerts.length > 0 && (
        <div className="mb-6 space-y-2">
          {openAlerts.map((alert) => (
            <div
              key={alert.id}
              className={cn(
                'flex items-center gap-3 rounded-lg border p-3 text-sm',
                alert.severity === 'critical'
                  ? 'border-red-500/30 bg-red-500/5'
                  : 'border-amber-500/30 bg-amber-500/5',
              )}
            >
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
              <span className="flex-1">{alert.message}</span>
              <span className="text-xs text-muted-foreground">
                since {relativeTime(alert.openedAt)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Uptime" value={formatUptime(health.uptimeSeconds)} />
        <Fact
          label="Load (1m)"
          value={health.load1 != null ? health.load1.toFixed(2) : '—'}
        />
        <Fact label="CPU cores" value={health.cpuCores ?? '—'} />
        <Fact
          label="Latency"
          value={health.latencyMs != null ? `${Math.round(health.latencyMs)} ms` : '—'}
        />
        <Fact label="OS" value={health.osName ?? '—'} />
        <Fact label="Kernel" value={health.kernel ?? '—'} />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <UsageBar
            label="CPU"
            percent={health.cpuPercent}
            tone={usageTone(health.cpuPercent)}
            detail={latest?.processCount != null ? `${latest.processCount} processes` : undefined}
          />
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <UsageBar
            label="Memory"
            percent={health.memPercent}
            tone={usageTone(health.memPercent)}
            detail={
              latest?.memTotalKb
                ? `${formatKb(latest.memUsedKb)} of ${formatKb(latest.memTotalKb)}${
                    latest.swapTotalKb ? ` · swap ${formatKb(latest.swapUsedKb)}` : ''
                  }`
                : undefined
            }
          />
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <UsageBar
            label="Disk"
            percent={health.diskPercent}
            tone={usageTone(health.diskPercent)}
            detail={
              latest?.diskTotalKb
                ? `${formatKb(latest.diskUsedKb)} of ${formatKb(latest.diskTotalKb)}`
                : undefined
            }
          />
        </div>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold">History</h2>
        <div className="flex gap-1 rounded-md border border-border p-0.5">
          {METRIC_RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                r === range ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-3 text-sm font-medium">CPU &amp; memory</h3>
          <MetricChart
            max={100}
            unit="%"
            series={[
              { label: 'CPU', color: CHART_COLORS.cpu, points: seriesFrom(samples, (m) => m.cpuPercent) },
              {
                label: 'Memory',
                color: CHART_COLORS.memory,
                points: seriesFrom(samples, (m) => m.memPercent),
              },
            ]}
          />
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-3 text-sm font-medium">Load average</h3>
          <MetricChart
            series={[
              { label: '1m', color: CHART_COLORS.load, points: seriesFrom(samples, (m) => m.load1) },
              { label: '15m', color: CHART_COLORS.disk, points: seriesFrom(samples, (m) => m.load15) },
            ]}
            formatValue={(v) => v.toFixed(1)}
          />
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-3 text-sm font-medium">Disk usage</h3>
          <MetricChart
            max={100}
            unit="%"
            series={[
              {
                label: 'Disk',
                color: CHART_COLORS.disk,
                points: seriesFrom(samples, (m) => m.diskPercent),
              },
            ]}
          />
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-3 text-sm font-medium">SSH response time</h3>
          <MetricChart
            series={[
              {
                label: 'Latency',
                color: CHART_COLORS.latency,
                points: seriesFrom(samples, (m) => m.latencyMs),
              },
            ]}
            formatValue={(v) => `${Math.round(v)}ms`}
          />
        </div>
      </div>

      {latest?.disks && latest.disks.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border p-4">
            <HardDrive size={16} className="text-muted-foreground" />
            <h2 className="font-semibold">Filesystems</h2>
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-2 text-left font-medium">Mount</th>
                <th className="px-4 py-2 text-left font-medium">Device</th>
                <th className="px-4 py-2 text-right font-medium">Used</th>
                <th className="px-4 py-2 text-right font-medium">Size</th>
                <th className="w-40 px-4 py-2 text-left font-medium">Usage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {latest.disks.map((disk) => (
                <tr key={disk.mount}>
                  <td className="px-4 py-2 font-mono text-xs">{disk.mount}</td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                    {disk.filesystem}
                  </td>
                  <td className="px-4 py-2 text-right">{formatKb(disk.usedKb)}</td>
                  <td className="px-4 py-2 text-right">{formatKb(disk.totalKb)}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn('h-full rounded-full', usageTone(disk.usedPercent))}
                          style={{ width: `${Math.min(disk.usedPercent, 100)}%` }}
                        />
                      </div>
                      <span className="w-10 text-right font-mono text-xs">
                        {disk.usedPercent.toFixed(0)}%
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {health.lastCheckedAt && (
        <p className="mt-4 text-xs text-muted-foreground">
          Last checked {relativeTime(health.lastCheckedAt)}
          {latest?.loggedInUsers != null && ` · ${latest.loggedInUsers} logged-in user(s)`}
        </p>
      )}
    </div>
  );
}
