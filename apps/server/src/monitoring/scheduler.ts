import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { serverHealth, servers } from '../db/schema.js';
import { config } from '../config/index.js';
import logger from '../logger.js';
import { checkServer, pauseHealth, pruneMetrics, type CheckOutcome } from './collector.js';

/**
 * The monitor runs in-process on a plain interval rather than through BullMQ.
 * Health checks must keep working in the default single-node deployment, which
 * has no Redis, and a missed sweep is not worth persisting or retrying — the
 * next one is a minute away.
 */
let timer: NodeJS.Timeout | null = null;
let sweeping = false;
let lastPruneAt = 0;

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Run `tasks` with a bounded number in flight, preserving input order in the result. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Check every monitored server once. Servers with monitoring switched off are
 * moved to `paused` so the UI can distinguish them from never-checked hosts.
 */
export async function runSweep(): Promise<CheckOutcome[]> {
  const db = getDb();
  const all = db.select().from(servers).all();

  const monitored = all.filter((s) => s.monitoringEnabled);
  const excluded = all.filter((s) => !s.monitoringEnabled);

  for (const server of excluded) {
    const current = db
      .select({ status: serverHealth.status })
      .from(serverHealth)
      .where(eq(serverHealth.serverId, server.id))
      .get();
    if (current?.status !== 'paused') pauseHealth(server);
  }

  if (monitored.length === 0) return [];

  const started = Date.now();
  const outcomes = await pooled(monitored, config.monitoring.concurrency, checkServer);

  const online = outcomes.filter((o) => o.status === 'online').length;
  logger.debug(
    { checked: outcomes.length, online, durationMs: Date.now() - started },
    'Health sweep complete',
  );

  return outcomes;
}

async function tick() {
  // Sweeps that overrun the interval must not stack up on a slow fleet.
  if (sweeping) {
    logger.warn('Previous health sweep still running, skipping this interval');
    return;
  }
  sweeping = true;
  try {
    await runSweep();

    if (Date.now() - lastPruneAt > PRUNE_INTERVAL_MS) {
      lastPruneAt = Date.now();
      const removed = pruneMetrics();
      if (removed > 0) logger.info({ removed }, 'Pruned expired server metrics');
    }
  } catch (err) {
    logger.error({ err }, 'Health sweep failed');
  } finally {
    sweeping = false;
  }
}

export function startHealthMonitor() {
  if (!config.monitoring.enabled) {
    logger.info('Health monitoring disabled (SMT_MONITORING_ENABLED=false)');
    return;
  }
  if (timer) return;

  const intervalMs = config.monitoring.intervalSeconds * 1000;
  timer = setInterval(tick, intervalMs);
  timer.unref?.();

  // Give the API a moment to come up before the first sweep hits the SSH stack.
  setTimeout(tick, 5_000).unref?.();

  logger.info(
    { intervalSeconds: config.monitoring.intervalSeconds, concurrency: config.monitoring.concurrency },
    'Health monitor started',
  );
}

export function stopHealthMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}
