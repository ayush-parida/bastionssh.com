/** Health states a server can be in, worst-to-best ordering handled in the UI. */
export type ServerStatus = 'unknown' | 'online' | 'offline' | 'error' | 'paused';

export type AlertType = 'offline' | 'cpu_high' | 'memory_high' | 'disk_high' | 'load_high';

export type AlertSeverity = 'warning' | 'critical';

export interface DiskUsage {
  mount: string;
  filesystem: string;
  totalKb: number;
  usedKb: number;
  usedPercent: number;
}

/** One polled sample of a server's vitals. Every metric is optional — a host
 *  that hides `/proc` or lacks `df` still yields a usable row. */
export interface ServerMetric {
  id: string;
  serverId: string;
  collectedAt: string;
  status: ServerStatus;
  latencyMs?: number;
  uptimeSeconds?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  cpuCores?: number;
  cpuPercent?: number;
  memTotalKb?: number;
  memUsedKb?: number;
  memPercent?: number;
  swapTotalKb?: number;
  swapUsedKb?: number;
  diskTotalKb?: number;
  diskUsedKb?: number;
  diskPercent?: number;
  processCount?: number;
  loggedInUsers?: number;
  disks?: DiskUsage[];
  error?: string;
}

/** Latest known state of a server — one row per server, updated in place. */
export interface ServerHealth {
  serverId: string;
  status: ServerStatus;
  monitoringEnabled: boolean;
  lastCheckedAt?: string;
  lastOnlineAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  latencyMs?: number;
  uptimeSeconds?: number;
  cpuPercent?: number;
  memPercent?: number;
  diskPercent?: number;
  load1?: number;
  cpuCores?: number;
  osName?: string;
  kernel?: string;
  hostname?: string;
  updatedAt?: string;
}

export interface ServerAlert {
  id: string;
  serverId: string;
  serverName?: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  value?: number;
  threshold?: number;
  openedAt: string;
  resolvedAt?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
}

export interface MonitoringSummary {
  total: number;
  online: number;
  offline: number;
  error: number;
  unknown: number;
  paused: number;
  activeAlerts: number;
}

/** Health joined with the identifying bits of its server, for list views. */
export interface ServerHealthWithServer extends ServerHealth {
  serverName: string;
  host: string;
  port: number;
  username: string;
  tags: string[];
  /** Recent CPU readings, oldest first; `null` marks a check that failed. */
  cpuTrend?: (number | null)[];
}

export interface MonitoringOverview {
  summary: MonitoringSummary;
  servers: ServerHealthWithServer[];
  alerts: ServerAlert[];
  intervalSeconds: number;
}

export interface ServerHealthDetail {
  health: ServerHealthWithServer;
  latest?: ServerMetric;
  alerts: ServerAlert[];
}

export const METRIC_RANGES = ['1h', '6h', '24h', '7d'] as const;
export type MetricRange = (typeof METRIC_RANGES)[number];

export interface MetricSeriesResponse {
  range: MetricRange;
  from: string;
  samples: ServerMetric[];
}
