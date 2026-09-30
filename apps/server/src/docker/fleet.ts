import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { DockerContainer, DockerFleetResponse, DockerFleetServer, DockerFleetSkipped } from '@smt/shared';
import { accessibleServerFilter } from '../auth/server-access.js';
import { getDb } from '../db/index.js';
import { servers } from '../db/schema.js';
import { DockerError } from './errors.js';
import { toContainer } from './objects.js';
import { withDockerClient } from './service.js';

/**
 * The cross-server container list (fleet view). Fans out to the servers the
 * caller can access — a few at a time, each with its own deadline — and
 * answers with whatever came back: one slow or broken server is an error on
 * its own row, never a failed page.
 *
 * Every server goes through `withDockerClient`, so per-server access, Docker
 * off and lazy detection apply exactly as on the server's own Docker tab.
 */

/** Tunables; tests shorten the deadline. */
export const fleetLimits = {
  /** Servers asked at once. */
  concurrency: 5,
  /** Per server: SSH connection (or lease), detection and the list. */
  timeoutMs: 10_000,
};

type Requester = Pick<FastifyRequest, 'orgId' | 'user'>;
type ServerRow = typeof servers.$inferSelect;

/**
 * Run `fn` over `items` with at most `limit` in flight, results in input
 * order. Stops starting new items once `signal` aborts (those resolve to
 * `onSkip`).
 */
export async function mapPooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  signal?: AbortSignal,
  onSkip?: (item: T) => R,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index]!;
      if (signal?.aborted && onSkip) {
        results[index] = onSkip(item);
        continue;
      }
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Which servers to ask. Without `requested`, every accessible server where
 * Docker was detected; servers never detected are listed as skipped so the
 * page can offer to check them (asking for one by id detects it, like
 * opening its Docker tab). Ids the caller cannot access are left out
 * silently, so the answer does not tell whether they exist.
 */
export function fleetTargets(req: Requester, requested?: string[]): { ask: ServerRow[]; skipped: DockerFleetSkipped[] } {
  const rows = getDb()
    .select()
    .from(servers)
    .where(and(eq(servers.orgId, req.orgId), accessibleServerFilter(req, servers.id)))
    .all()
    .sort((a, b) => a.name.localeCompare(b.name));
  const wanted = requested ? new Set(requested) : null;
  const ask: ServerRow[] = [];
  const skipped: DockerFleetSkipped[] = [];
  for (const row of rows) {
    if (wanted && !wanted.has(row.id)) continue;
    if (row.dockerMode === 'off') {
      skipped.push({ serverId: row.id, serverName: row.name, reason: 'off' });
    } else if (!wanted && !row.dockerDetectedAt) {
      skipped.push({ serverId: row.id, serverName: row.name, reason: 'not_detected' });
    } else {
      ask.push(row);
    }
  }
  return { ask, skipped };
}

function failure(err: unknown): { error: string; code?: string } {
  if (err instanceof DockerError) {
    const body = err.toJSON();
    return { error: body.error, ...('code' in body && body.code ? { code: body.code } : {}) };
  }
  return { error: err instanceof Error ? err.message : 'Could not list containers' };
}

/** One server's containers within the deadline, or the reason it has none. */
async function listOne(req: Requester, server: ServerRow, all: boolean, signal?: AbortSignal): Promise<DockerFleetServer> {
  const started = Date.now();
  const deadline = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let stop = () => {};
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      deadline.abort();
      reject(new DockerError(`No answer within ${fleetLimits.timeoutMs / 1000} s`, 504));
    }, fleetLimits.timeoutMs);
    stop = () => {
      deadline.abort();
      reject(new DockerError('Request cancelled', 499));
    };
  });
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  const base = { serverId: server.id, serverName: server.name };
  try {
    // The race covers the SSH connection and detection too, which take no signal;
    // the lease is still released when they finish (withDockerClient)
    const containers = await Promise.race([
      withDockerClient(req, server.id, async (ctx): Promise<DockerContainer[]> => {
        const raw = await ctx.docker.json<Record<string, unknown>[]>({
          path: '/containers/json',
          query: { all },
          signal: deadline.signal,
        });
        return raw.map(toContainer);
      }),
      timedOut,
    ]);
    return { ...base, ok: true, containers, durationMs: Date.now() - started };
  } catch (err) {
    return { ...base, ok: false, containers: [], ...failure(err), durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    // A late rejection of the race's losing side has nobody to report to
    timedOut.catch(() => {});
  }
}

/**
 * Containers across the caller's servers. `signal` aborts when the browser
 * leaves: servers not yet asked are then not asked at all, and requests in
 * flight are cancelled.
 */
export async function fleetContainers(
  req: Requester,
  opts: { serverIds?: string[]; all: boolean; signal?: AbortSignal },
): Promise<DockerFleetResponse> {
  const { ask, skipped } = fleetTargets(req, opts.serverIds);
  const results = await mapPooled(
    ask,
    fleetLimits.concurrency,
    (server) => listOne(req, server, opts.all, opts.signal),
    opts.signal,
    (server) => ({
      serverId: server.id,
      serverName: server.name,
      ok: false,
      containers: [],
      error: 'Request cancelled',
      durationMs: 0,
    }),
  );
  return { servers: results, skipped };
}
