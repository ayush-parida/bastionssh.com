import type { KubeResourceAmounts } from '@smt/shared';
import type { KubeClient } from './client.js';
import { bytes, cpuMillis } from './quantity.js';

/**
 * Live usage from `metrics.k8s.io` (metrics-server), when the cluster has
 * it — many small clusters do not, and the views simply show requests
 * without usage then. Whether it exists is checked once per cluster and
 * remembered for {@link DETECT_TTL_MS}; the readings themselves are never
 * cached here (they are a minute old already).
 */

const DETECT_TTL_MS = 5 * 60 * 1000;
const METRICS_TIMEOUT_MS = 8_000;
const BASE = '/apis/metrics.k8s.io/v1beta1';

const detected = new Map<string, { available: boolean; at: number }>();

interface MetricsItem {
  metadata?: { name?: string; namespace?: string };
  usage?: { cpu?: string; memory?: string };
  containers?: { name?: string; usage?: { cpu?: string; memory?: string } }[];
}

/** True when the metrics API answers for this cluster (checked at most every few minutes). */
export async function metricsAvailable(clusterKey: string, client: KubeClient): Promise<boolean> {
  const known = detected.get(clusterKey);
  if (known && Date.now() - known.at < DETECT_TTL_MS) return known.available;
  let available = false;
  try {
    await client.raw(BASE, { timeoutMs: METRICS_TIMEOUT_MS });
    available = true;
  } catch {
    available = false;
  }
  detected.set(clusterKey, { available, at: Date.now() });
  return available;
}

function amounts(usage: MetricsItem['usage']): KubeResourceAmounts {
  return { cpuMillis: cpuMillis(usage?.cpu), memoryBytes: bytes(usage?.memory) };
}

/** Usage per node name, or null when metrics are not available or not readable. */
export async function nodeUsage(clusterKey: string, client: KubeClient): Promise<Map<string, KubeResourceAmounts> | null> {
  if (!(await metricsAvailable(clusterKey, client))) return null;
  try {
    const list = await client.raw<{ items?: MetricsItem[] }>(`${BASE}/nodes`, { timeoutMs: METRICS_TIMEOUT_MS });
    return new Map((list.items ?? []).filter((i) => i.metadata?.name).map((i) => [i.metadata!.name!, amounts(i.usage)]));
  } catch {
    return null;
  }
}

/** Usage per pod (`namespace/name`), summed over containers; null when unavailable. */
export async function podUsage(
  clusterKey: string,
  client: KubeClient,
  namespace: string | null,
): Promise<Map<string, KubeResourceAmounts> | null> {
  if (!(await metricsAvailable(clusterKey, client))) return null;
  try {
    const path = namespace ? `${BASE}/namespaces/${encodeURIComponent(namespace)}/pods` : `${BASE}/pods`;
    const list = await client.raw<{ items?: MetricsItem[] }>(path, { timeoutMs: METRICS_TIMEOUT_MS });
    const out = new Map<string, KubeResourceAmounts>();
    for (const item of list.items ?? []) {
      if (!item.metadata?.name) continue;
      const total = { cpuMillis: 0, memoryBytes: 0 };
      for (const c of item.containers ?? []) {
        const a = amounts(c.usage);
        total.cpuMillis += a.cpuMillis;
        total.memoryBytes += a.memoryBytes;
      }
      out.set(`${item.metadata.namespace ?? ''}/${item.metadata.name}`, total);
    }
    return out;
  } catch {
    return null;
  }
}

/** Forget what was detected (tests; a cluster that was edited). */
export function forgetMetrics(clusterKey?: string): void {
  if (clusterKey) detected.delete(clusterKey);
  else detected.clear();
}
