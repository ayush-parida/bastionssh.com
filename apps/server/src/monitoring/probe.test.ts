import { describe, it, expect } from 'vitest';
import { cpuPercentBetween, parseProbeOutput } from './probe.js';
import { evaluateConditions } from './alerts.js';

const LINUX_OUTPUT = `hostname web-01
os Ubuntu 22.04.4 LTS
kernel Linux 5.15.0-107-generic
uptime 864000.42 1720000.11
load 1.25 0.98 0.74 2/431 21876
cpu 120000 500 40000 900000 8000 0 1200 0 0 0
cores 4
mem MemTotal: 8039232
mem MemFree: 512000
mem MemAvailable: 2048000
mem Buffers: 128000
mem Cached: 1400000
mem SwapTotal: 2097152
mem SwapFree: 2000000
disk /dev/vda1 51343664 20537464 /
disk tmpfs 803924 1232 /run
disk /dev/vdb1 103081248 98000000 /var/lib/data
disk /dev/loop0 63488 63488 /snap/core20/2318
procs 432
users 2`;

describe('parseProbeOutput', () => {
  const sample = parseProbeOutput(LINUX_OUTPUT);

  it('reads identity and uptime', () => {
    expect(sample.hostname).toBe('web-01');
    expect(sample.osName).toBe('Ubuntu 22.04.4 LTS');
    expect(sample.kernel).toBe('Linux 5.15.0-107-generic');
    expect(sample.uptimeSeconds).toBeCloseTo(864000.42);
  });

  it('reads load average and core count', () => {
    expect(sample.load1).toBe(1.25);
    expect(sample.load5).toBe(0.98);
    expect(sample.load15).toBe(0.74);
    expect(sample.cpuCores).toBe(4);
  });

  it('sums cpu jiffies and counts iowait as idle', () => {
    expect(sample.cpuTotalJiffies).toBe(1069700);
    expect(sample.cpuIdleJiffies).toBe(908000);
  });

  it('derives used memory from MemAvailable', () => {
    expect(sample.memTotalKb).toBe(8039232);
    expect(sample.memUsedKb).toBe(8039232 - 2048000);
    expect(sample.swapUsedKb).toBe(2097152 - 2000000);
  });

  it('keeps real filesystems and drops pseudo ones', () => {
    expect(sample.disks.map((d) => d.mount)).toEqual(['/', '/var/lib/data']);
    expect(sample.disks[0]?.usedPercent).toBeCloseTo(40.0, 0);
  });

  it('uses the root filesystem as the headline disk', () => {
    expect(sample.diskTotalKb).toBe(51343664);
    expect(sample.diskUsedKb).toBe(20537464);
  });

  it('subtracts the ps header from the process count', () => {
    expect(sample.processCount).toBe(431);
    expect(sample.loggedInUsers).toBe(2);
  });

  it('survives a host that returns almost nothing', () => {
    const bare = parseProbeOutput('hostname minimal\nkernel Darwin 23.5.0\n');
    expect(bare.hostname).toBe('minimal');
    expect(bare.disks).toEqual([]);
    expect(bare.memTotalKb).toBeUndefined();
    expect(bare.cpuTotalJiffies).toBeUndefined();
  });

  it('ignores malformed and unknown lines', () => {
    const noisy = parseProbeOutput('\n\nbanner Welcome to prod\nload notanumber\ndisk /dev/sda1\n');
    expect(noisy.load1).toBeUndefined();
    expect(noisy.disks).toEqual([]);
  });

  it('counts a bind-mounted device once', () => {
    // Containers bind-mount single files; df reports each under the same device.
    const container = parseProbeOutput(
      [
        'disk /dev/vda1 1000 500 /data',
        'disk /dev/vda1 1000 500 /mnt/data-alias',
        'disk /dev/vda1 1000 500 /etc/hosts',
      ].join('\n'),
    );
    expect(container.disks).toHaveLength(1);
    expect(container.disks[0]?.mount).toBe('/data');
  });

  it('drops container and macOS synthetic mounts', () => {
    const noise = parseProbeOutput(
      [
        'disk overlay 900 100 /',
        'disk /dev/vda1 100 20 /etc/resolv.conf',
        'disk /dev/disk3s6 500 50 /System/Volumes/VM',
      ].join('\n'),
    );
    expect(noise.disks).toEqual([]);
    expect(noise.diskTotalKb).toBeUndefined();
  });

  it('falls back to the largest filesystem when there is no root mount', () => {
    const noRoot = parseProbeOutput('disk /dev/sdb1 200 100 /data\ndisk /dev/sdc1 400 100 /big');
    expect(noRoot.diskTotalKb).toBe(400);
  });
});

describe('cpuPercentBetween', () => {
  const current = parseProbeOutput(LINUX_OUTPUT);

  it('computes busy time between two readings', () => {
    // 1000 more jiffies total, 250 of them idle → 75% busy
    const previous = { totalJiffies: 1069700 - 1000, idleJiffies: 908000 - 250 };
    expect(cpuPercentBetween(previous, current)).toBe(75);
  });

  it('returns undefined without a previous reading', () => {
    expect(cpuPercentBetween(undefined, current)).toBeUndefined();
  });

  it('returns undefined when counters reset after a reboot', () => {
    expect(
      cpuPercentBetween({ totalJiffies: 99_999_999, idleJiffies: 99_999_999 }, current),
    ).toBeUndefined();
  });

  it('clamps to the 0-100 range', () => {
    const previous = { totalJiffies: 1069700 - 1000, idleJiffies: 908000 };
    expect(cpuPercentBetween(previous, current)).toBe(100);
  });
});

describe('evaluateConditions', () => {
  /** Same host, minus the nearly-full /var/lib/data mount. */
  const HEALTHY_OUTPUT = LINUX_OUTPUT.split('\n')
    .filter((l) => !l.includes('/var/lib/data'))
    .join('\n');

  it('reports nothing for a healthy host', () => {
    expect(
      evaluateConditions({
        status: 'online',
        consecutiveFailures: 0,
        cpuPercent: 12,
        sample: parseProbeOutput(HEALTHY_OUTPUT),
      }),
    ).toEqual([]);
  });

  it('opens an offline alert only after the failure threshold', () => {
    const once = evaluateConditions({ status: 'offline', consecutiveFailures: 1 });
    expect(once).toEqual([]);

    const twice = evaluateConditions({
      status: 'offline',
      consecutiveFailures: 2,
      lastError: 'connect ECONNREFUSED',
    });
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({ type: 'offline', severity: 'critical' });
  });

  it('skips resource checks when the host is unreachable', () => {
    const conditions = evaluateConditions({
      status: 'offline',
      consecutiveFailures: 5,
      cpuPercent: 99,
      sample: parseProbeOutput(LINUX_OUTPUT),
    });
    expect(conditions.map((c) => c.type)).toEqual(['offline']);
  });

  it('flags a full non-root filesystem', () => {
    const conditions = evaluateConditions({
      status: 'online',
      consecutiveFailures: 0,
      sample: parseProbeOutput(LINUX_OUTPUT),
    });
    // /var/lib/data is at ~95%, / is only at 40%
    expect(conditions.map((c) => c.type)).toContain('disk_high');
    expect(conditions.find((c) => c.type === 'disk_high')?.message).toContain('/var/lib/data');
  });

  it('escalates a percentage metric to critical halfway to its ceiling', () => {
    // Default CPU threshold is 90% -> warning at 90-94.9%, critical from 95%.
    const warning = evaluateConditions({
      status: 'online',
      consecutiveFailures: 0,
      cpuPercent: 92,
      sample: parseProbeOutput(HEALTHY_OUTPUT),
    });
    expect(warning.find((c) => c.type === 'cpu_high')?.severity).toBe('warning');

    const critical = evaluateConditions({
      status: 'online',
      consecutiveFailures: 0,
      cpuPercent: 99.9,
      sample: parseProbeOutput(HEALTHY_OUTPUT),
    });
    expect(critical.find((c) => c.type === 'cpu_high')?.severity).toBe('critical');
  });

  it('measures load relative to core count', () => {
    // 12.0 across 4 cores is 3.0 per core, past 1.15x the default threshold of 2.
    const busy = parseProbeOutput(`${LINUX_OUTPUT}\nload 12.0 8.0 7.0`);
    const conditions = evaluateConditions({
      status: 'online',
      consecutiveFailures: 0,
      sample: busy,
    });
    expect(conditions.find((c) => c.type === 'load_high')).toMatchObject({ severity: 'critical' });
  });
});
