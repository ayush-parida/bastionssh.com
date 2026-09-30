import type { DockerEngineInfo, DockerServerStatus } from '@smt/shared';
import { HardDrive, ShieldAlert } from 'lucide-react';
import { formatBytes } from '@/lib/utils.js';
import { DetectDockerButton } from './DetectDocker.js';

function Fact({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`truncate text-sm font-medium ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}

/**
 * Top of a server's Docker tab: which engine, how it is reached, how much disk
 * it uses — and that whoever can use it is effectively root on the server.
 */
export default function DockerHeader({ status, info }: { status: DockerServerStatus; info: DockerEngineInfo | undefined }) {
  const { docker, permissions } = status;
  const usage = info?.diskUsage;
  return (
    <div className="mb-4 rounded-lg border border-border bg-card p-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Fact
          label="Engine"
          value={info ? `${info.serverVersion}${info.rootless ? ' (rootless)' : ''}` : (docker.version ?? '—')}
        />
        <Fact label="API version" value={docker.apiVersion ?? '—'} mono />
        <Fact label="Transport" value={docker.transport === 'dial-stdio' ? 'docker system dial-stdio' : (docker.transport ?? '—')} />
        <Fact label="Socket" value={docker.detectedSocketPath ?? docker.socketPath ?? '—'} mono />
        <Fact
          label="Disk usage"
          value={
            usage ? (
              <span title={`Images ${formatBytes(usage.images.size)} · containers ${formatBytes(usage.containers.size)} · volumes ${formatBytes(usage.volumes.size)} · build cache ${formatBytes(usage.buildCache.size)}`}>
                <HardDrive size={12} className="mr-1 inline" />
                {formatBytes(usage.total)}
                {usage.images.reclaimable + usage.containers.reclaimable + usage.volumes.reclaimable > 0 && (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    ({formatBytes(usage.images.reclaimable + usage.containers.reclaimable + usage.volumes.reclaimable)} reclaimable)
                  </span>
                )}
              </span>
            ) : (
              '—'
            )
          }
        />
      </div>
      {info && (
        <p className="mt-3 text-xs text-muted-foreground">
          {info.operatingSystem} · {info.architecture} · {info.ncpu} CPU · {formatBytes(info.memTotal, 1)} ·{' '}
          {info.containersRunning} running, {info.containersStopped} stopped, {info.images} images
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <ShieldAlert size={13} className="mt-0.5 shrink-0" />
          Access to the Docker socket is root-equivalent on this server: anyone who can run containers can take it over.
        </p>
        {permissions.configure && <DetectDockerButton serverId={status.serverId} label="Detect again" />}
      </div>
    </div>
  );
}
