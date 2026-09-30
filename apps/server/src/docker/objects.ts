import type {
  DockerContainer,
  DockerContainerState,
  DockerDiskUsage,
  DockerDiskUsageEntry,
  DockerEngineEvent,
  DockerEngineInfo,
  DockerHealth,
  DockerImage,
  DockerNetwork,
  DockerStatsSample,
  DockerVolume,
} from '@smt/shared';
import type { DaemonEndpoint } from './transport.js';

/**
 * Engine API payloads mapped onto the app's own shapes, so the UI depends on
 * a stable contract rather than on whichever API version a server speaks.
 * Every field is read defensively: Podman and old engines omit some.
 */

type Raw = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const obj = (v: unknown): Raw => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function labels(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj(v))) if (typeof value === 'string') out[key] = value;
  return out;
}

/** Unix seconds (list endpoints) or an RFC 3339 string (inspect) as ISO. */
export function isoTime(v: unknown): string | null {
  if (typeof v === 'number' && v > 0) return new Date(v * 1000).toISOString();
  if (typeof v === 'string' && v && !v.startsWith('0001-')) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

const STATES: DockerContainerState[] = ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'];

/** Health from the status text (`Up 3 hours (healthy)`), which every API version has. */
export function healthFromStatus(status: string): DockerHealth {
  if (/\(unhealthy\)/.test(status)) return 'unhealthy';
  if (/\(healthy\)/.test(status)) return 'healthy';
  if (/\(health: starting\)/.test(status)) return 'starting';
  return null;
}

export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

export function toContainer(raw: Raw): DockerContainer {
  const names = arr(raw.Names).filter((n): n is string => typeof n === 'string');
  const state = str(raw.State).toLowerCase() as DockerContainerState;
  const status = str(raw.Status);
  const containerLabels = labels(raw.Labels);
  return {
    id: str(raw.Id),
    name: (names[0] ?? str(raw.Id).slice(0, 12)).replace(/^\//, ''),
    image: str(raw.Image),
    imageId: str(raw.ImageID),
    command: str(raw.Command),
    createdAt: isoTime(raw.Created) ?? new Date(0).toISOString(),
    state: STATES.includes(state) ? state : 'created',
    status,
    health: healthFromStatus(status),
    ports: arr(raw.Ports).map((p) => {
      const port = obj(p);
      return {
        privatePort: num(port.PrivatePort),
        publicPort: typeof port.PublicPort === 'number' ? port.PublicPort : null,
        type: str(port.Type, 'tcp'),
        ip: typeof port.IP === 'string' && port.IP ? port.IP : null,
      };
    }),
    labels: containerLabels,
    composeProject: containerLabels[COMPOSE_PROJECT_LABEL] ?? null,
    composeService: containerLabels[COMPOSE_SERVICE_LABEL] ?? null,
  };
}

/** Image ids used by containers, from a raw `containers/json?all=1` list. */
export function imagesInUse(containers: Raw[]): Set<string> {
  return new Set(containers.map((c) => str(c.ImageID)).filter(Boolean));
}

export function toImage(raw: Raw, inUse: Set<string>): DockerImage {
  const repoTags = arr(raw.RepoTags).filter((t): t is string => typeof t === 'string' && t !== '<none>:<none>');
  const repoDigests = arr(raw.RepoDigests).filter((t): t is string => typeof t === 'string' && t !== '<none>@<none>');
  const id = str(raw.Id);
  return {
    id,
    repoTags,
    repoDigests,
    size: num(raw.Size),
    createdAt: isoTime(raw.Created) ?? new Date(0).toISOString(),
    containers: num(raw.Containers, -1),
    inUse: inUse.has(id),
    dangling: repoTags.length === 0,
  };
}

/** Volume names mounted by containers, from a raw `containers/json?all=1` list. */
export function volumesInUse(containers: Raw[]): Set<string> {
  const names = new Set<string>();
  for (const c of containers) {
    for (const m of arr(c.Mounts)) {
      const mount = obj(m);
      if (mount.Type === 'volume' && typeof mount.Name === 'string') names.add(mount.Name);
    }
  }
  return names;
}

export function toVolume(raw: Raw, inUse: Set<string>): DockerVolume {
  const usage = obj(raw.UsageData);
  const size = typeof usage.Size === 'number' && usage.Size >= 0 ? usage.Size : null;
  const name = str(raw.Name);
  return {
    name,
    driver: str(raw.Driver),
    mountpoint: str(raw.Mountpoint),
    scope: str(raw.Scope, 'local'),
    createdAt: isoTime(raw.CreatedAt),
    labels: labels(raw.Labels),
    inUse: inUse.has(name),
    size,
  };
}

/** Containers per network name, from a raw `containers/json?all=1` list (the network list leaves them out). */
export function containersPerNetwork(containers: Raw[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of containers) {
    for (const name of Object.keys(obj(obj(c.NetworkSettings).Networks))) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

export function toNetwork(raw: Raw, counts: Map<string, number>): DockerNetwork {
  const name = str(raw.Name);
  const attached = Object.keys(obj(raw.Containers)).length;
  return {
    id: str(raw.Id),
    name,
    driver: str(raw.Driver),
    scope: str(raw.Scope, 'local'),
    internal: raw.Internal === true,
    attachable: raw.Attachable === true,
    subnets: arr(obj(raw.IPAM).Config)
      .map((c) => str(obj(c).Subnet))
      .filter(Boolean),
    containers: Math.max(attached, counts.get(name) ?? 0),
    createdAt: isoTime(raw.Created),
  };
}

const entry = (count: number, size: number, reclaimable: number): DockerDiskUsageEntry => ({
  count,
  size: Math.max(0, size),
  reclaimable: Math.max(0, Math.min(reclaimable, size)),
});

/** `/system/df`, summarised the way `docker system df` does. */
export function toDiskUsage(raw: Raw): DockerDiskUsage {
  const images = arr(raw.Images).map(obj);
  const layers = num(raw.LayersSize, images.reduce((sum, i) => sum + num(i.Size), 0));
  const usedByImages = images
    .filter((i) => num(i.Containers) > 0)
    .reduce((sum, i) => sum + num(i.Size) - Math.max(0, num(i.SharedSize)), 0);

  const containers = arr(raw.Containers).map(obj);
  const containerSize = containers.reduce((sum, c) => sum + num(c.SizeRw), 0);
  const stoppedSize = containers
    .filter((c) => str(c.State) !== 'running')
    .reduce((sum, c) => sum + num(c.SizeRw), 0);

  const volumes = arr(raw.Volumes).map((v) => obj(obj(v).UsageData));
  const volumeSize = volumes.reduce((sum, u) => sum + Math.max(0, num(u.Size)), 0);
  const unusedVolumes = volumes
    .filter((u) => num(u.RefCount) === 0)
    .reduce((sum, u) => sum + Math.max(0, num(u.Size)), 0);

  const cache = arr(raw.BuildCache).map(obj);
  const cacheSize = cache.filter((c) => c.Shared !== true).reduce((sum, c) => sum + num(c.Size), 0);
  const cacheReclaimable = cache.filter((c) => c.InUse !== true).reduce((sum, c) => sum + num(c.Size), 0);

  const usage = {
    images: entry(images.length, layers, layers - usedByImages),
    containers: entry(containers.length, containerSize, stoppedSize),
    volumes: entry(volumes.length, volumeSize, unusedVolumes),
    buildCache: entry(cache.length, cacheSize, cacheReclaimable),
  };
  return {
    ...usage,
    total: usage.images.size + usage.containers.size + usage.volumes.size + usage.buildCache.size,
  };
}

export function toEngineInfo(
  info: Raw,
  apiVersion: string,
  endpoint: DaemonEndpoint,
  diskUsage: DockerDiskUsage | null,
): DockerEngineInfo {
  const security = arr(info.SecurityOptions).filter((s): s is string => typeof s === 'string');
  return {
    name: str(info.Name),
    serverVersion: str(info.ServerVersion),
    apiVersion,
    operatingSystem: str(info.OperatingSystem),
    osType: str(info.OSType),
    architecture: str(info.Architecture),
    kernelVersion: str(info.KernelVersion),
    ncpu: num(info.NCPU),
    memTotal: num(info.MemTotal),
    storageDriver: str(info.Driver),
    rootless: security.some((s) => s.includes('name=rootless')),
    containers: num(info.Containers),
    containersRunning: num(info.ContainersRunning),
    containersPaused: num(info.ContainersPaused),
    containersStopped: num(info.ContainersStopped),
    images: num(info.Images),
    transport: endpoint.transport,
    socketPath: endpoint.socketPath,
    diskUsage,
  };
}

/**
 * One `/containers/:id/stats` frame as a sample. CPU is the share of all the
 * host's CPUs times their count, like `docker stats` (so 200% = two cores);
 * memory leaves out reclaimable page cache, like `docker stats`.
 */
export function toStatsSample(raw: Raw): DockerStatsSample {
  const cpu = obj(raw.cpu_stats);
  const pre = obj(raw.precpu_stats);
  const cpuDelta = num(obj(cpu.cpu_usage).total_usage) - num(obj(pre.cpu_usage).total_usage);
  const systemDelta = num(cpu.system_cpu_usage) - num(pre.system_cpu_usage);
  const cpus = num(cpu.online_cpus) || arr(obj(cpu.cpu_usage).percpu_usage).length || 1;
  const cpuPercent = cpuDelta > 0 && systemDelta > 0 ? (cpuDelta / systemDelta) * cpus * 100 : 0;

  const memory = obj(raw.memory_stats);
  const memStats = obj(memory.stats);
  // cgroup v2 reports inactive_file, v1 total_inactive_file (older engines subtracted cache)
  const cache = num(memStats.inactive_file, num(memStats.total_inactive_file, num(memStats.cache)));
  const memUsage = Math.max(0, num(memory.usage) - cache);
  const memLimit = num(memory.limit);

  let netRx = 0;
  let netTx = 0;
  for (const n of Object.values(obj(raw.networks))) {
    netRx += num(obj(n).rx_bytes);
    netTx += num(obj(n).tx_bytes);
  }

  let blockRead = 0;
  let blockWrite = 0;
  for (const e of arr(obj(raw.blkio_stats).io_service_bytes_recursive)) {
    const op = str(obj(e).op).toLowerCase();
    if (op === 'read') blockRead += num(obj(e).value);
    else if (op === 'write') blockWrite += num(obj(e).value);
  }

  return {
    time: isoTime(raw.read) ?? new Date().toISOString(),
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memUsage,
    memLimit,
    memPercent: memLimit > 0 ? Math.round((memUsage / memLimit) * 10_000) / 100 : 0,
    netRx,
    netTx,
    blockRead,
    blockWrite,
    pids: num(obj(raw.pids_stats).current),
  };
}

/**
 * An event's action without what the engine appends to exec actions:
 * `exec_create: sh -c "mysql -p…"` carries the command line, which may hold
 * secrets, and viewers (who may not read logs) receive these events.
 */
export function eventAction(action: string): string {
  return action.startsWith('exec_') ? action.replace(/:.*$/s, '') : action;
}

export function toEngineEvent(raw: Raw): DockerEngineEvent {
  const actor = obj(raw.Actor);
  const attributes = obj(actor.Attributes);
  const timeNano = num(raw.timeNano);
  return {
    type: str(raw.Type, str(raw.type)),
    action: eventAction(str(raw.Action, str(raw.status))),
    id: str(actor.ID, str(raw.id)),
    name: typeof attributes.name === 'string' ? attributes.name : null,
    time: timeNano ? new Date(timeNano / 1e6).toISOString() : (isoTime(raw.time) ?? new Date().toISOString()),
  };
}
