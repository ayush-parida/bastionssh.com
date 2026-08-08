import type { ServerStatus } from '@smt/shared';

export interface StatusMeta {
  label: string;
  dot: string;
  text: string;
  badge: string;
}

export const STATUS_META: Record<ServerStatus, StatusMeta> = {
  online: {
    label: 'Online',
    dot: 'bg-emerald-500',
    text: 'text-emerald-500',
    badge: 'bg-emerald-500/10 text-emerald-500',
  },
  offline: {
    label: 'Offline',
    dot: 'bg-red-500',
    text: 'text-red-500',
    badge: 'bg-red-500/10 text-red-500',
  },
  error: {
    label: 'Error',
    dot: 'bg-amber-500',
    text: 'text-amber-500',
    badge: 'bg-amber-500/10 text-amber-500',
  },
  unknown: {
    label: 'Not checked',
    dot: 'bg-muted-foreground/50',
    text: 'text-muted-foreground',
    badge: 'bg-muted text-muted-foreground',
  },
  paused: {
    label: 'Paused',
    dot: 'bg-muted-foreground/50',
    text: 'text-muted-foreground',
    badge: 'bg-muted text-muted-foreground',
  },
};

export function statusMeta(status: ServerStatus): StatusMeta {
  return STATUS_META[status] ?? STATUS_META.unknown;
}

/** Compact uptime: "12d 4h", "4h 21m", "3m". */
export function formatUptime(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Size formatter for values already expressed in kibibytes. */
export function formatKb(kb?: number): string {
  if (kb == null || !Number.isFinite(kb)) return '—';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = kb;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatPercent(value?: number): string {
  return value == null ? '—' : `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

/** Green below 70%, amber to 90%, red beyond — matches the default alert thresholds. */
export function usageTone(percent?: number): string {
  if (percent == null) return 'bg-muted-foreground/30';
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 70) return 'bg-amber-500';
  return 'bg-emerald-500';
}

/** Chart colours, resolved from literals so SVG `stroke` can use them directly. */
export const CHART_COLORS = {
  cpu: '#6366f1',
  memory: '#10b981',
  disk: '#f59e0b',
  load: '#ec4899',
  latency: '#0ea5e9',
} as const;
