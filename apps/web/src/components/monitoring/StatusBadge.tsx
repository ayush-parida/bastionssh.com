import type { ServerStatus } from '@smt/shared';
import { cn } from '@/lib/utils.js';
import { statusMeta } from '@/lib/monitoring.js';

export function StatusDot({ status, className }: { status: ServerStatus; className?: string }) {
  const meta = statusMeta(status);
  return (
    <span
      title={meta.label}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        meta.dot,
        status === 'offline' && 'animate-pulse',
        className,
      )}
    />
  );
}

export default function StatusBadge({
  status,
  className,
}: {
  status: ServerStatus;
  className?: string;
}) {
  const meta = statusMeta(status);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        meta.badge,
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', meta.dot)} />
      {meta.label}
    </span>
  );
}

/** Labelled usage meter used for CPU / memory / disk. */
export function UsageBar({
  label,
  percent,
  detail,
  tone,
}: {
  label: string;
  percent?: number;
  detail?: string;
  tone: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">
          {percent == null ? '—' : `${percent.toFixed(percent >= 10 ? 0 : 1)}%`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-all', tone)}
          style={{ width: `${Math.min(percent ?? 0, 100)}%` }}
        />
      </div>
      {detail && <p className="mt-1 truncate text-[11px] text-muted-foreground">{detail}</p>}
    </div>
  );
}
