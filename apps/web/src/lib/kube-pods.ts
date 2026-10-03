import { useQuery } from '@tanstack/react-query';
import type { KubeExecRequest, KubeExecSession, KubeLogEvent, KubePodDetail, KubeResource } from '@smt/shared';
import { kubeObjectPath } from '@smt/shared';
import { api } from '@/lib/api.js';
import { readSSE } from '@/lib/sse.js';
import { kubePath } from '@/lib/kube.js';

/** Inside a pod (K4): the pod panel, logs, shells and the read-only YAML. */

/** API path of a pod's endpoints: `/kube/clusters/<id>/pods/<ns>/<name><rest>`. */
export const podPath = (clusterId: string, namespace: string, name: string, rest = '') =>
  kubePath(clusterId, `/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}${rest}`);

export const podKeys = {
  detail: (clusterId: string, namespace: string, name: string) => ['kube', clusterId, 'pod', namespace, name] as const,
  yaml: (clusterId: string, path: string) => ['kube', clusterId, 'yaml', path] as const,
};

/** Live usage is a reading, not a watched object: refresh it this often while the panel is open. */
const USAGE_REFRESH_MS = 15_000;

/** The pod panel's picture: container lanes, lifecycle, usage (shared by the overview and the logs tab). */
export function usePodDetail(clusterId: string, namespace: string, name: string) {
  return useQuery<KubePodDetail>({
    queryKey: podKeys.detail(clusterId, namespace, name),
    queryFn: () => api.get(podPath(clusterId, namespace, name)),
    retry: false,
    refetchInterval: (query) => (query.state.data?.metricsAvailable ? USAGE_REFRESH_MS : false),
  });
}

/** The read-only YAML endpoint of any object. */
export function yamlPath(clusterId: string, ref: { resource: KubeResource; namespace: string | null; name: string }): string {
  return kubePath(clusterId, `/${kubeObjectPath(ref)}/yaml`);
}

export interface LogQuery {
  container?: string;
  previous?: boolean;
  follow?: boolean;
  tail?: number;
  timestamps?: boolean;
}

function logQuery(q: LogQuery): string {
  const params = new URLSearchParams();
  if (q.container) params.set('container', q.container);
  if (q.previous) params.set('previous', '1');
  if (q.follow) params.set('follow', '1');
  if (q.timestamps) params.set('timestamps', '1');
  if (q.tail !== undefined) params.set('tail', String(q.tail));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** Read a pod's log stream until it ends, the signal aborts, or it fails (thrown). */
export async function followPodLogs(
  clusterId: string,
  namespace: string,
  name: string,
  query: LogQuery,
  signal: AbortSignal,
  onEvent: (event: KubeLogEvent) => void,
): Promise<void> {
  const res = await api.getStream(podPath(clusterId, namespace, name, `/logs${logQuery(query)}`), { signal });
  for await (const event of readSSE<KubeLogEvent>(res)) {
    if (signal.aborted) return;
    onEvent(event);
  }
}

export function downloadPodLogs(clusterId: string, namespace: string, name: string, query: LogQuery): Promise<void> {
  const file = `${name}-${query.container ?? 'logs'}${query.previous ? '-previous' : ''}.log`;
  return api.download(podPath(clusterId, namespace, name, `/logs/download${logQuery({ ...query, follow: false })}`), file);
}

export function openPodShell(clusterId: string, namespace: string, name: string, request: KubeExecRequest = {}) {
  return api.post<KubeExecSession>(podPath(clusterId, namespace, name, '/exec'), {
    cols: 220,
    rows: 50,
    ...request,
  });
}

/** Router state the terminal page reads for a pod shell (pages/Terminal.tsx). */
export interface PodTerminalState {
  sessionId: string;
  recording: KubeExecSession['recording'];
  pod: KubeExecSession['pod'];
}

/** Where a pod shell's terminal opens (pages/Terminal.tsx, with {@link PodTerminalState}). */
export const podShellUrl = (clusterId: string) => `/kubernetes/${encodeURIComponent(clusterId)}/shell`;
