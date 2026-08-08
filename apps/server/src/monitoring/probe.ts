import { Client } from 'ssh2';
import type { DiskUsage } from '@smt/shared';

/**
 * A single read-only vitals probe.
 *
 * Everything is guarded so a host missing `/proc`, `df`, `who` or `ps` still
 * returns whatever it does have instead of failing the whole check. Output is
 * line-oriented `key value...` pairs consumed by {@link parseProbeOutput}.
 */
export const PROBE_SCRIPT = `LC_ALL=C; export LC_ALL
echo "hostname $(hostname 2>/dev/null || uname -n 2>/dev/null)"
if [ -r /etc/os-release ]; then . /etc/os-release 2>/dev/null; echo "os \${PRETTY_NAME:-\${NAME:-unknown}}"; fi
echo "kernel $(uname -s 2>/dev/null) $(uname -r 2>/dev/null)"
[ -r /proc/uptime ] && echo "uptime $(cat /proc/uptime 2>/dev/null)"
[ -r /proc/loadavg ] && echo "load $(cat /proc/loadavg 2>/dev/null)"
[ -r /proc/stat ] && awk '/^cpu /{sub(/^cpu +/,""); print "cpu " $0; exit}' /proc/stat 2>/dev/null
echo "cores $(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null)"
[ -r /proc/meminfo ] && awk '/^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):/ {printf "mem %s %s\\n", $1, $2}' /proc/meminfo 2>/dev/null
df -Pk 2>/dev/null | tail -n +2 | awk '{print "disk " $1 " " $2 " " $3 " " $6}'
echo "procs $(ps -e 2>/dev/null | wc -l)"
echo "users $(who 2>/dev/null | wc -l)"
exit 0`;

/** Virtual/ephemeral filesystems that would otherwise dominate the disk list. */
const PSEUDO_FILESYSTEMS = new Set([
  'tmpfs',
  'devtmpfs',
  'devfs',
  'overlay',
  'none',
  'udev',
  'squashfs',
  'efivarfs',
  'shm',
  'ramfs',
  'cgroup',
  'cgroup2',
  'map',
]);

/**
 * `/etc` catches the file bind-mounts every container gets (`/etc/hosts`,
 * `/etc/resolv.conf`), and `/System/Volumes` the ones macOS synthesises.
 */
const PSEUDO_MOUNT_PREFIXES = [
  '/snap',
  '/sys',
  '/proc',
  '/dev',
  '/run',
  '/etc',
  '/var/lib/docker',
  '/System/Volumes',
];

function isRealFilesystem(filesystem: string, mount: string): boolean {
  if (PSEUDO_FILESYSTEMS.has(filesystem)) return false;
  if (filesystem.startsWith('/dev/loop')) return false;
  if (mount === '/') return true;
  return !PSEUDO_MOUNT_PREFIXES.some((p) => mount === p || mount.startsWith(`${p}/`));
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface ProbeSample {
  hostname?: string;
  osName?: string;
  kernel?: string;
  uptimeSeconds?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  cpuCores?: number;
  /** Cumulative jiffies since boot; CPU percent is a delta against the prior sample. */
  cpuTotalJiffies?: number;
  cpuIdleJiffies?: number;
  memTotalKb?: number;
  memUsedKb?: number;
  swapTotalKb?: number;
  swapUsedKb?: number;
  disks: DiskUsage[];
  /** Headline filesystem — `/` when present, otherwise the largest real one. */
  diskTotalKb?: number;
  diskUsedKb?: number;
  processCount?: number;
  loggedInUsers?: number;
}

/**
 * Turn the probe's `key value...` lines into a sample. Unknown keys and
 * malformed lines are ignored rather than throwing — partial data beats none.
 */
export function parseProbeOutput(stdout: string): ProbeSample {
  const sample: ProbeSample = { disks: [] };
  const mem: Record<string, number> = {};

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const [key, ...rest] = line.split(/\s+/);

    switch (key) {
      case 'hostname':
        if (rest[0]) sample.hostname = rest.join(' ');
        break;

      case 'os': {
        const name = rest.join(' ').replace(/^["']|["']$/g, '');
        if (name && name !== 'unknown') sample.osName = name;
        break;
      }

      case 'kernel':
        if (rest[0]) sample.kernel = rest.join(' ');
        break;

      case 'uptime':
        // "<uptime seconds> <idle seconds>"
        sample.uptimeSeconds = num(rest[0]);
        break;

      case 'load':
        sample.load1 = num(rest[0]);
        sample.load5 = num(rest[1]);
        sample.load15 = num(rest[2]);
        break;

      case 'cpu': {
        // user nice system idle iowait irq softirq steal guest guest_nice
        const fields = rest.map((f) => num(f)).filter((f): f is number => f !== undefined);
        const idle = fields[3];
        if (fields.length >= 4 && idle !== undefined) {
          sample.cpuTotalJiffies = fields.reduce((a, b) => a + b, 0);
          // idle + iowait: time the CPU had nothing runnable
          sample.cpuIdleJiffies = idle + (fields[4] ?? 0);
        }
        break;
      }

      case 'cores': {
        const cores = num(rest[0]);
        if (cores && cores > 0) sample.cpuCores = Math.round(cores);
        break;
      }

      case 'mem': {
        const label = rest[0]?.replace(/:$/, '');
        const value = num(rest[1]);
        if (label && value !== undefined) mem[label] = value;
        break;
      }

      case 'disk': {
        const [filesystem, totalRaw, usedRaw, ...mountParts] = rest;
        const mount = mountParts.join(' ');
        const totalKb = num(totalRaw);
        const usedKb = num(usedRaw);
        if (!filesystem || !mount || !totalKb || usedKb === undefined) break;
        if (!isRealFilesystem(filesystem, mount)) break;
        // Bind mounts show the same device and figures under several paths;
        // counting them once keeps the totals and the worst-mount alert honest.
        const seen = sample.disks.some(
          (d) =>
            d.mount === mount ||
            (d.filesystem === filesystem && d.totalKb === totalKb && d.usedKb === usedKb),
        );
        if (seen) break;
        sample.disks.push({
          filesystem,
          mount,
          totalKb,
          usedKb,
          usedPercent: round2((usedKb / totalKb) * 100),
        });
        break;
      }

      case 'procs': {
        const count = num(rest[0]);
        // `ps -e | wc -l` counts the header row
        if (count !== undefined) sample.processCount = Math.max(count - 1, 0);
        break;
      }

      case 'users':
        sample.loggedInUsers = num(rest[0]);
        break;
    }
  }

  if (mem.MemTotal) {
    sample.memTotalKb = mem.MemTotal;
    // MemAvailable is the honest number; fall back to the free+reclaimable estimate.
    const available =
      mem.MemAvailable ?? (mem.MemFree ?? 0) + (mem.Buffers ?? 0) + (mem.Cached ?? 0);
    sample.memUsedKb = Math.max(mem.MemTotal - available, 0);
  }
  if (mem.SwapTotal) {
    sample.swapTotalKb = mem.SwapTotal;
    sample.swapUsedKb = Math.max(mem.SwapTotal - (mem.SwapFree ?? 0), 0);
  }

  const headline =
    sample.disks.find((d) => d.mount === '/') ??
    [...sample.disks].sort((a, b) => b.totalKb - a.totalKb)[0];
  if (headline) {
    sample.diskTotalKb = headline.totalKb;
    sample.diskUsedKb = headline.usedKb;
  }

  return sample;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * CPU utilisation between two `/proc/stat` readings. Returns undefined when the
 * counters went backwards (reboot) or no time elapsed.
 */
export function cpuPercentBetween(
  previous: { totalJiffies?: number | null; idleJiffies?: number | null } | undefined,
  current: ProbeSample,
): number | undefined {
  if (
    !previous?.totalJiffies ||
    previous.idleJiffies == null ||
    current.cpuTotalJiffies === undefined ||
    current.cpuIdleJiffies === undefined
  ) {
    return undefined;
  }
  const totalDelta = current.cpuTotalJiffies - previous.totalJiffies;
  const idleDelta = current.cpuIdleJiffies - previous.idleJiffies;
  if (totalDelta <= 0 || idleDelta < 0) return undefined;
  const percent = ((totalDelta - idleDelta) / totalDelta) * 100;
  return round2(Math.min(Math.max(percent, 0), 100));
}

export interface ProbeTarget {
  host: string;
  port: number;
  username: string;
}

export interface ProbeAuth {
  privateKey?: string;
  password?: string;
}

export interface ProbeResult {
  sample: ProbeSample;
  /** Round-trip time of the SSH handshake plus command, in milliseconds. */
  latencyMs: number;
}

export class ProbeError extends Error {
  constructor(
    message: string,
    readonly kind: 'offline' | 'error' = 'error',
  ) {
    super(message);
    this.name = 'ProbeError';
  }
}

/** Connection-level failures mean the host is unreachable; everything else is a config/auth error. */
function classify(err: NodeJS.ErrnoException): 'offline' | 'error' {
  const offlineCodes = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND'];
  if (err.code && offlineCodes.includes(err.code)) return 'offline';
  if (/timed out|timeout/i.test(err.message)) return 'offline';
  return 'error';
}

/**
 * Open a short-lived SSH connection, run the probe, and disconnect. Deliberately
 * unpooled: a health check that reuses a cached connection can report "online"
 * for a host that no longer accepts new ones.
 */
export function runProbe(
  target: ProbeTarget,
  auth: ProbeAuth,
  timeoutMs = 20_000,
): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const ssh = new Client();
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ssh.end();
      } catch {
        // already torn down
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new ProbeError(`Probe timed out after ${timeoutMs}ms`, 'offline')));
    }, timeoutMs);

    ssh.on('ready', () => {
      ssh.exec(PROBE_SCRIPT, (err, stream) => {
        if (err) return finish(() => reject(new ProbeError(err.message)));

        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => {
          stdout += d.toString();
        });
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        stream.on('close', (code: number) => {
          const latencyMs = Date.now() - started;
          const sample = parseProbeOutput(stdout);
          const gotAnything =
            sample.uptimeSeconds !== undefined ||
            sample.memTotalKb !== undefined ||
            sample.disks.length > 0 ||
            sample.hostname !== undefined;

          if (!gotAnything) {
            const detail = stderr.trim().split('\n')[0] || `probe exited with code ${code}`;
            return finish(() => reject(new ProbeError(`No metrics returned: ${detail}`)));
          }
          finish(() => resolve({ sample, latencyMs }));
        });
      });
    });

    ssh.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => reject(new ProbeError(err.message, classify(err))));
    });

    ssh.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: Math.min(timeoutMs, 15_000),
      ...(auth.privateKey ? { privateKey: auth.privateKey } : {}),
      ...(auth.password ? { password: auth.password } : {}),
    });
  });
}
