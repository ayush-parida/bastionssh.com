import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  KubeClusterStatus,
  KubeClusterStatusView,
  KubeGraphHealth,
  KubePermissions,
  KubePodTileStatus,
  KubeStreamEvent,
  KubeStreamView,
  KubeWorkloadHealth,
} from '@smt/shared';
import { KUBE_CLUSTER_SCOPE } from '@smt/shared';
import { api } from '@/lib/api.js';
import { readSSE } from '@/lib/sse.js';
import { useAuthStore } from '@/store/auth.js';

/** API paths for one cluster. */
export const kubePath = (clusterId: string, rest = '') => `/kube/clusters/${clusterId}${rest}`;

/** React Query keys: every view of a cluster sits under `['kube', clusterId]`, so the change feed refreshes them together. */
export const kubeKeys = {
  clusters: ['kube', 'clusters'] as const,
  cluster: (clusterId: string) => ['kube', clusterId, 'status'] as const,
  overview: (clusterId: string) => ['kube', clusterId, 'overview'] as const,
  namespaces: (clusterId: string) => ['kube', clusterId, 'namespaces'] as const,
  workloads: (clusterId: string, namespace: string | null) => ['kube', clusterId, 'workloads', namespace ?? '*'] as const,
  object: (clusterId: string, path: string) => ['kube', clusterId, 'object', path] as const,
  settings: ['kube-settings'] as const,
  // K2: under the object's key, so its change feed refreshes the insight too
  insight: (clusterId: string, path: string) => ['kube', clusterId, 'object', path, 'insight'] as const,
  graph: (clusterId: string, namespace: string | null) => ['kube', clusterId, 'graph', namespace ?? '*'] as const,
  events: (clusterId: string, namespace: string | null, since: string) => ['kube', clusterId, 'events', namespace ?? '*', since] as const,
  attention: (clusterId: string, namespace: string | null) => ['kube', clusterId, 'attention', namespace ?? '*'] as const,
  storage: (clusterId: string, namespace: string | null) => ['kube', clusterId, 'storage', namespace ?? '*'] as const,
  config: (clusterId: string, namespace: string | null) => ['kube', clusterId, 'config', namespace ?? '*'] as const,
};

/** Cluster page tabs (spec §5.5), in order; each one's body lives in its own file under components/kube. */
export type KubeTab = 'map' | 'apps' | 'workloads' | 'events' | 'nodes' | 'storage' | 'config';

export const KUBE_TABS: { id: KubeTab; label: string }[] = [
  { id: 'map', label: 'Map' },
  { id: 'apps', label: 'Apps' },
  { id: 'workloads', label: 'Workloads' },
  { id: 'events', label: 'Events' },
  { id: 'nodes', label: 'Nodes' },
  { id: 'storage', label: 'Storage' },
  { id: 'config', label: 'Config' },
];

export function isKubeTab(value: string | undefined): value is KubeTab {
  return KUBE_TABS.some((t) => t.id === value);
}

/** The web URL of a cluster tab: `/kubernetes/<id>` for the map, `/kubernetes/<id>/<tab>` otherwise. */
export function kubeTabUrl(clusterId: string, tab: KubeTab = 'map'): string {
  return `/kubernetes/${encodeURIComponent(clusterId)}${tab === 'map' ? '' : `/${tab}`}`;
}

/**
 * Router state when opening an object's panel: the tab it was opened from
 * stays underneath and is where closing the panel returns to. A shared link
 * (no state) opens over the map.
 */
export interface KubeObjectLinkState {
  tab: KubeTab;
}

/** The cluster and what the caller may do on it; shared by the cluster page and its tabs. */
export function useKubeCluster(clusterId: string | undefined) {
  return useQuery<KubeClusterStatusView>({
    queryKey: kubeKeys.cluster(clusterId ?? ''),
    queryFn: () => api.get(kubePath(clusterId!)),
    enabled: !!clusterId,
    retry: false,
  });
}

/**
 * What the caller may do where an object lives: in its namespace when their
 * access is narrowed to some namespaces (custom roles — possibly more than on
 * the cluster as a whole), else on the cluster as a whole, which is also what
 * cluster-scoped objects use. UI-side only; the server checks again.
 */
export function permissionsIn(
  view: KubeClusterStatusView | undefined,
  namespace: string | null | undefined,
): KubePermissions | undefined {
  if (!view) return undefined;
  if (!namespace || namespace === KUBE_CLUSTER_SCOPE) return view.permissions;
  return view.namespacePermissions?.[namespace] ?? view.permissions;
}

/**
 * Follow a cluster's change feed for one view while the component is
 * mounted; each `changed` (already coalesced by the server) refetches the
 * view's queries. Reconnects with backoff — after an edit of the cluster or a
 * dropped connection — and gives up after a few failures in a row.
 */
export function useKubeChanges(
  clusterId: string | undefined,
  view: KubeStreamView,
  params: Record<string, string | null | undefined>,
  queryKey: readonly unknown[] | null,
  enabled = true,
) {
  const qc = useQueryClient();
  const query = new URLSearchParams({ view });
  for (const [k, v] of Object.entries(params)) if (v) query.set(k, v);
  const qs = query.toString();
  const key = queryKey ? JSON.stringify(queryKey) : null;
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!clusterId || !enabled || !key) return;
    const abort = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const refresh = () => qc.invalidateQueries({ queryKey: JSON.parse(key) as unknown[] });

    const connect = () => {
      void (async () => {
        let ready = false;
        try {
          const res = await api.getStream(kubePath(clusterId, `/stream?${qs}`), { signal: abort.signal });
          for await (const event of readSSE<KubeStreamEvent>(res)) {
            if (abort.signal.aborted) return;
            if (event.type === 'ready') {
              ready = true;
              failures = 0;
              setLive(true);
              // Anything that changed while (re)connecting
              refresh();
            } else if (event.type === 'changed') refresh();
            // Access changed: nothing to reconnect to
            else if (event.type === 'error' && event.status === 403) failures = Infinity;
          }
        } catch {
          // refused (404, 429…) or the connection dropped
        } finally {
          setLive(false);
          if (!ready) failures++;
          if (!abort.signal.aborted && failures < 6) retry = setTimeout(connect, Math.min(1_000 * 2 ** failures, 30_000));
        }
      })();
    };
    connect();
    return () => {
      abort.abort();
      clearTimeout(retry);
    };
  }, [clusterId, qs, key, enabled, qc]);

  return live;
}

/** The namespace picked on a cluster, remembered per user and cluster in this browser ('' = all). */
export function useKubeNamespace(clusterId: string): [string, (ns: string) => void] {
  const userId = useAuthStore((s) => s.user?.id ?? 'anon');
  const storageKey = `kube-namespace:${userId}:${clusterId}`;
  const [namespace, setNamespace] = useState(() => {
    try {
      return localStorage.getItem(storageKey) ?? '';
    } catch {
      return '';
    }
  });
  const set = (ns: string) => {
    setNamespace(ns);
    try {
      if (ns) localStorage.setItem(storageKey, ns);
      else localStorage.removeItem(storageKey);
    } catch {
      // private mode: the choice lasts for this page only
    }
  };
  return [namespace, set];
}

// ── Colours and words ────────────────────────────────────────

/** Pod tiles on the cluster map (spec §5.1). */
export const TILE_STYLE: Record<KubePodTileStatus, string> = {
  running: 'bg-emerald-500 border-emerald-600',
  pending: 'bg-amber-400 border-amber-500',
  failing: 'bg-red-500 border-red-600',
  completed: 'bg-zinc-300 border-zinc-400 dark:bg-zinc-600 dark:border-zinc-500',
  terminating: 'bg-violet-500 border-violet-600',
};

export const TILE_LABEL: Record<KubePodTileStatus, string> = {
  running: 'Running',
  pending: 'Pending / starting',
  failing: 'Failing',
  completed: 'Completed',
  terminating: 'Terminating',
};

export const HEALTH_DOT: Record<KubeWorkloadHealth | KubePodTileStatus, string> = {
  healthy: 'bg-emerald-500',
  running: 'bg-emerald-500',
  progressing: 'bg-sky-500',
  pending: 'bg-amber-400',
  degraded: 'bg-amber-500',
  failed: 'bg-red-500',
  failing: 'bg-red-500',
  suspended: 'bg-zinc-400',
  completed: 'bg-zinc-400',
  idle: 'bg-zinc-300 dark:bg-zinc-600',
  terminating: 'bg-violet-500',
};

export const HEALTH_LABEL: Record<KubeWorkloadHealth, string> = {
  healthy: 'Healthy',
  progressing: 'Updating',
  // The graph's word for the same state (GRAPH_HEALTH_STYLE.warning)
  degraded: 'Needs a look',
  failed: 'Failing',
  suspended: 'Suspended',
  completed: 'Completed',
  idle: 'Idle',
};

/** A word for an object's health, whichever kind of health it has. */
export function healthLabel(health: KubeWorkloadHealth | KubePodTileStatus): string {
  return (HEALTH_LABEL as Record<string, string>)[health] ?? TILE_LABEL[health as KubePodTileStatus] ?? health;
}

export const CLUSTER_DOT: Record<KubeClusterStatus, string> = {
  ok: 'bg-emerald-500',
  error: 'bg-red-500',
  unknown: 'bg-zinc-400',
};

export const CLUSTER_STATUS_LABEL: Record<KubeClusterStatus, string> = {
  ok: 'Reachable',
  error: 'Unreachable',
  unknown: 'Not checked yet',
};

/** Topology graph nodes by health (spec §5.2): the same colours as the map's tiles. */
export const GRAPH_HEALTH_STYLE: Record<KubeGraphHealth, { border: string; dot: string; label: string }> = {
  healthy: { border: 'border-emerald-500', dot: 'bg-emerald-500', label: 'Healthy' },
  progressing: { border: 'border-sky-500', dot: 'bg-sky-500', label: 'Updating' },
  warning: { border: 'border-amber-500', dot: 'bg-amber-500', label: 'Needs a look' },
  failing: { border: 'border-red-500', dot: 'bg-red-500', label: 'Failing' },
  idle: { border: 'border-zinc-300 dark:border-zinc-600', dot: 'bg-zinc-400', label: 'Idle' },
  missing: { border: 'border-red-500 border-dashed', dot: 'bg-red-500', label: 'Does not exist' },
};

/** `5 min ago`, `3 h ago`, `2 d ago`; '' without a time. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** How long between two times, in words: `20 min`, `3 h`. */
export function span(from: string | null, to: string | null): string {
  const a = from ? Date.parse(from) : NaN;
  const b = to ? Date.parse(to) : NaN;
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return '';
  const s = Math.round((b - a) / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}

/** `1500` millicores → `1.5 cores`; `250` → `250m`. */
export function formatCpu(millis: number): string {
  if (millis >= 1000) return `${(millis / 1000).toFixed(millis % 1000 ? 1 : 0)} cores`;
  return `${Math.round(millis)}m`;
}

/** Memory in binary units, short: `512 MiB`, `3.5 GiB`. */
export function formatMemory(bytes: number): string {
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
  if (bytes >= 2 ** 20) return `${Math.round(bytes / 2 ** 20)} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
}

export function percent(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}
