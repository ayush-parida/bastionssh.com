import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DockerContainer, DockerContainerState, DockerHealth, DockerStreamEvent } from '@smt/shared';
import { api } from '@/lib/api.js';
import { readSSE } from '@/lib/sse.js';

/** API paths for one server's Docker. */
export const dockerPath = (serverId: string, rest = '') => `/docker/servers/${serverId}${rest}`;

/** React Query keys, so every list refreshes from one place when events arrive. */
export const dockerKeys = {
  status: (serverId: string) => ['docker', serverId, 'status'] as const,
  info: (serverId: string) => ['docker', serverId, 'info'] as const,
  containers: (serverId: string) => ['docker', serverId, 'containers'] as const,
  images: (serverId: string) => ['docker', serverId, 'images'] as const,
  volumes: (serverId: string) => ['docker', serverId, 'volumes'] as const,
  networks: (serverId: string) => ['docker', serverId, 'networks'] as const,
  inspect: (serverId: string, id: string) => ['docker', serverId, 'inspect', id] as const,
  top: (serverId: string, id: string) => ['docker', serverId, 'top', id] as const,
  settings: ['docker-settings'] as const,
};

/**
 * Follow a Docker event stream (logs, stats, events) until `signal` aborts.
 * Resolves when the stream ends; rejects with the HTTP error when it could
 * not start (the caller shows it).
 */
export async function followDockerStream(
  path: string,
  signal: AbortSignal,
  onEvent: (event: DockerStreamEvent) => void,
): Promise<void> {
  const res = await api.getStream(path, { signal });
  for await (const event of readSSE<DockerStreamEvent>(res)) {
    if (signal.aborted) return;
    onEvent(event);
  }
}

/** Refetch lists shortly after engine events, batched so a burst causes one refresh. */
export function useDockerEvents(serverId: string | undefined, enabled: boolean) {
  const qc = useQueryClient();
  const pending = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!serverId || !enabled) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      for (const type of pending.current) {
        if (type === 'container') qc.invalidateQueries({ queryKey: dockerKeys.containers(serverId) });
        if (type === 'image') qc.invalidateQueries({ queryKey: dockerKeys.images(serverId) });
        if (type === 'volume') qc.invalidateQueries({ queryKey: dockerKeys.volumes(serverId) });
        if (type === 'network') qc.invalidateQueries({ queryKey: dockerKeys.networks(serverId) });
      }
      pending.current.clear();
      qc.invalidateQueries({ queryKey: dockerKeys.info(serverId) });
    };

    const connect = (attempt: number) => {
      followDockerStream(dockerPath(serverId, '/events'), abort.signal, (event) => {
        if (event.type !== 'event') return;
        pending.current.add(event.event.type);
        clearTimeout(timer);
        timer = setTimeout(flush, 400);
      })
        .catch(() => {})
        .finally(() => {
          // Reconnect with backoff while the tab is open; revocation or a 4xx ends up here too
          if (!abort.signal.aborted && attempt < 5) retry = setTimeout(() => connect(attempt + 1), 2_000 * (attempt + 1));
        });
    };
    connect(0);

    return () => {
      abort.abort();
      clearTimeout(timer);
      clearTimeout(retry);
    };
  }, [serverId, enabled, qc]);
}

export const STATE_STYLE: Record<DockerContainerState, string> = {
  running: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  restarting: 'bg-amber-500/10 text-amber-600',
  paused: 'bg-sky-500/10 text-sky-600',
  created: 'bg-muted text-muted-foreground',
  removing: 'bg-muted text-muted-foreground',
  exited: 'bg-muted text-muted-foreground',
  dead: 'bg-red-500/10 text-red-600',
};

export const HEALTH_STYLE: Record<Exclude<DockerHealth, null>, string> = {
  healthy: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  unhealthy: 'bg-red-500/10 text-red-600',
  starting: 'bg-amber-500/10 text-amber-600',
};

export function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

/** `0.0.0.0:8080→80/tcp`, one entry per published or exposed port. */
export function formatPorts(container: DockerContainer): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of container.ports) {
    const text = p.publicPort ? `${p.publicPort}→${p.privatePort}/${p.type}` : `${p.privatePort}/${p.type}`;
    if (!seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

/** `Up 3 hours (healthy)` → `Up 3 hours`, the health shown as its own badge. */
export function uptimeText(status: string): string {
  return status.replace(/\s*\((healthy|unhealthy|health: starting)\)/, '');
}
