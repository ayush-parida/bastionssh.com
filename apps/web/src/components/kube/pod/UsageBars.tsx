import type { KubeContainerView } from '@smt/shared';
import { Cpu, MemoryStick } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { formatCpu, formatMemory } from '@/lib/kube.js';

/**
 * One container's CPU and memory as a picture (spec §5.3): the bar is live
 * usage, a dashed tick marks what it asked for (request — what the scheduler
 * reserved) and the bar's end is its limit, where CPU is throttled and memory
 * gets the container killed (OOMKilled). Without a limit the scale is the
 * larger of request and usage, with room to spare, and says "no limit".
 */

type Amount = number | null;

/** `1 core`, not `1 cores`. */
const cpu = (millis: number) => formatCpu(millis).replace(/^1 cores$/, '1 core');

/** How close usage is to the limit, as a colour. */
function tone(usage: number, limit: Amount): string {
  if (!limit) return 'bg-sky-500';
  const p = usage / limit;
  return p >= 0.9 ? 'bg-red-500' : p >= 0.75 ? 'bg-amber-500' : 'bg-emerald-500';
}

function sentence(label: string, usage: Amount, request: Amount, limit: Amount, format: (n: number) => string): string {
  const parts = [
    usage !== null ? `${format(usage)} in use` : 'usage unknown',
    request !== null ? `asked for ${format(request)}` : 'no request',
    limit !== null ? `limit ${format(limit)}` : 'no limit',
  ];
  return `${label}: ${parts.join(', ')}`;
}

export function UsageBar({
  icon: Icon,
  label,
  usage,
  request,
  limit,
  format,
}: {
  icon: typeof Cpu;
  label: string;
  usage: Amount;
  request: Amount;
  limit: Amount;
  format: (n: number) => string;
}) {
  // The bar's full width: the limit, else room above the request or usage
  const scale = limit ?? Math.max(request ?? 0, usage ?? 0) * 1.25;
  const pct = (n: number) => (scale > 0 ? Math.min(100, (n / scale) * 100) : 0);
  const over = limit !== null && usage !== null && usage > limit;
  const text = sentence(label, usage, request, limit, format);
  return (
    <div className="space-y-1" title={text} data-testid={`usage-${label.toLowerCase()}`}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1 text-muted-foreground">
          <Icon size={12} aria-hidden /> {label}
        </span>
        <span className="truncate tabular-nums text-muted-foreground">
          {usage !== null ? <span className="text-foreground">{format(usage)}</span> : '—'}
          {limit !== null ? ` of ${format(limit)}` : ' · no limit'}
          {request !== null && ` · asked ${format(request)}`}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-muted" role="img" aria-label={text}>
        {usage !== null && scale > 0 && (
          <div
            className={cn('absolute inset-y-0 left-0 rounded-full', tone(usage, limit), over && 'animate-pulse')}
            style={{ width: `${Math.max(2, pct(usage))}%` }}
          />
        )}
        {request !== null && scale > 0 && (
          <div
            className="absolute -inset-y-0.5 w-0 border-l-2 border-dashed border-foreground/60"
            style={{ left: `calc(${pct(request)}% - 1px)` }}
            aria-hidden
          />
        )}
        {limit === null && <div className="absolute inset-y-0 right-0 w-6 rounded-r-full bg-gradient-to-r from-transparent to-card" aria-hidden />}
      </div>
    </div>
  );
}

/** CPU and memory bars of one container; `metricsAvailable` false says why usage is missing. */
export default function UsageBars({ container, metricsAvailable }: { container: KubeContainerView; metricsAvailable: boolean }) {
  const { usage, requests, limits } = container;
  const nothing = !usage && requests.cpuMillis === null && requests.memoryBytes === null && limits.cpuMillis === null && limits.memoryBytes === null;
  if (nothing) {
    return (
      <p className="text-xs text-muted-foreground">
        No requests or limits set{metricsAvailable ? '' : ', and the cluster has no metrics server'} — it can use whatever the node has free.
      </p>
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <UsageBar icon={Cpu} label="CPU" usage={usage?.cpuMillis ?? null} request={requests.cpuMillis} limit={limits.cpuMillis} format={cpu} />
      <UsageBar
        icon={MemoryStick}
        label="Memory"
        usage={usage?.memoryBytes ?? null}
        request={requests.memoryBytes}
        limit={limits.memoryBytes}
        format={formatMemory}
      />
    </div>
  );
}
