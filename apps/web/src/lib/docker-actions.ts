import type {
  DockerContainerAction,
  DockerContainerActionRequest,
  DockerActionResult,
  DockerExecRequest,
  DockerExecSession,
  DockerPullProgress,
  DockerPullRequest,
  DockerStreamEvent,
} from '@smt/shared';
import { api, ApiError } from '@/lib/api.js';
import { readSSE } from '@/lib/sse.js';
import { dockerPath } from '@/lib/docker.js';

/** Calls behind the Docker actions (D2) and container shells (D3). */

export function containerAction(
  serverId: string,
  containerId: string,
  action: DockerContainerAction,
  body: DockerContainerActionRequest = {},
): Promise<DockerActionResult> {
  return api.post(dockerPath(serverId, `/containers/${encodeURIComponent(containerId)}/${action}`), body);
}

export function removeContainer(serverId: string, containerId: string, opts: { force: boolean; volumes: boolean }) {
  const q = new URLSearchParams({ force: opts.force ? '1' : '0', volumes: opts.volumes ? '1' : '0' });
  return api.delete(dockerPath(serverId, `/containers/${encodeURIComponent(containerId)}?${q}`));
}

export function removeImage(serverId: string, imageId: string, force: boolean) {
  return api.delete(dockerPath(serverId, `/images/${encodeURIComponent(imageId)}?force=${force ? 1 : 0}`));
}

/**
 * Pull an image, reporting each progress line, until the daemon is done or
 * `signal` aborts (which cancels the pull). Rejects with the pull's error.
 */
export async function pullImage(
  serverId: string,
  request: DockerPullRequest,
  signal: AbortSignal,
  onProgress: (progress: DockerPullProgress) => void,
): Promise<void> {
  const res = await api.stream(dockerPath(serverId, '/images/pull'), request, { signal });
  for await (const event of readSSE<DockerStreamEvent>(res)) {
    if (event.type === 'pull') onProgress(event.progress);
    if (event.type === 'error') throw new ApiError(event.error, event.status ?? 502);
    if (event.type === 'end') return;
  }
  if (!signal.aborted) throw new Error('The pull stopped before Docker said it was done');
}

/** Open a shell in a running container, sized for the terminal about to show it. */
export function openContainerShell(serverId: string, containerId: string, request: DockerExecRequest = {}) {
  // Roughly what the terminal page fits; it sends its real size as soon as it attaches
  const cols = Math.max(80, Math.floor((window.innerWidth - 32) / 8.4));
  const rows = Math.max(24, Math.floor((window.innerHeight - 60) / 17));
  return api.post<DockerExecSession>(dockerPath(serverId, `/containers/${encodeURIComponent(containerId)}/exec`), {
    cols: Math.min(cols, 1000),
    rows: Math.min(rows, 500),
    ...request,
  });
}
