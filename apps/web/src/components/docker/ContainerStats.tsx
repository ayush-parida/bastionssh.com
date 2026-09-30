import { useEffect, useState } from 'react';
import type { DockerStatsSample } from '@smt/shared';
import MetricChart from '@/components/charts/MetricChart.js';
import { CHART_COLORS } from '@/lib/monitoring.js';
import { dockerPath, followDockerStream } from '@/lib/docker.js';
import { formatBytes } from '@/lib/utils.js';

/** Samples kept for the chart: two minutes at one a second. */
const WINDOW = 120;

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

/** Live CPU and memory of one container, while the tab is open (the stream stops when it closes). */
export default function ContainerStats({ serverId, containerId }: { serverId: string; containerId: string }) {
  const [samples, setSamples] = useState<DockerStatsSample[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    setSamples([]);
    setError(null);
    followDockerStream(dockerPath(serverId, `/containers/${containerId}/stats`), abort.signal, (event) => {
      if (event.type === 'stats') setSamples((prev) => [...prev.slice(-(WINDOW - 1)), event.sample]);
      else if (event.type === 'error') setError(event.error);
    }).catch((err: Error) => {
      if (!abort.signal.aborted) setError(err.message);
    });
    return () => abort.abort();
  }, [serverId, containerId]);

  const latest = samples.at(-1);
  if (error) return <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>;
  if (!latest) return <p className="text-sm text-muted-foreground">Waiting for the first sample…</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <Fact label="CPU" value={`${latest.cpuPercent.toFixed(1)}%`} />
        <Fact label="Memory" value={`${formatBytes(latest.memUsage, 1)}${latest.memLimit ? ` / ${formatBytes(latest.memLimit, 1)}` : ''}`} />
        <Fact label="Processes" value={String(latest.pids)} />
        <Fact label="Network in / out" value={`${formatBytes(latest.netRx, 1)} / ${formatBytes(latest.netTx, 1)}`} />
        <Fact label="Block read / write" value={`${formatBytes(latest.blockRead, 1)} / ${formatBytes(latest.blockWrite, 1)}`} />
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">CPU %</p>
        <MetricChart
          height={140}
          unit="%"
          // Idle containers sit well under 1%: keep the axis labels distinct
          formatValue={(v) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)}%`}
          series={[{ label: 'CPU', color: CHART_COLORS.cpu, points: samples.map((s) => ({ t: s.time, v: s.cpuPercent })) }]}
          emptyMessage="Collecting…"
        />
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Memory %</p>
        <MetricChart
          height={140}
          max={100}
          unit="%"
          series={[{ label: 'Memory', color: CHART_COLORS.memory, points: samples.map((s) => ({ t: s.time, v: s.memPercent })) }]}
          emptyMessage="Collecting…"
        />
      </div>
    </div>
  );
}
