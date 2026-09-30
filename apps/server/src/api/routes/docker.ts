import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type {
  DockerContainer,
  DockerDiskUsage,
  DockerEngineInfo,
  DockerImage,
  DockerLogLine,
  DockerMode,
  DockerNetwork,
  DockerServerStatus,
  DockerSettings,
  DockerTop,
  DockerTransport,
  DockerVolume,
} from '@smt/shared';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { canAccessServer } from '../../auth/server-access.js';
import { audit } from '../../audit/index.js';
import { getDb } from '../../db/index.js';
import { servers } from '../../db/schema.js';
import { CredentialError } from '../../ssh/credentials.js';
import { JumpHostError } from '../../ssh/jump.js';
import { boolQuery } from '../query.js';
import { DockerError } from '../../docker/errors.js';
import { Demuxer, LineSplitter, type DockerStreamType } from '../../docker/demux.js';
import { redactInspect } from '../../docker/redact.js';
import { permissionsFor, requireDocker } from '../../docker/permissions.js';
import { dockerSettings, updateDockerSettings } from '../../docker/settings.js';
import { closeDisallowedExecSessions } from '../../docker/exec.js';
import { apiPath, containerRef, imageRef } from '../../docker/validation.js';
import {
  containersPerNetwork,
  imagesInUse,
  toContainer,
  toDiskUsage,
  toEngineEvent,
  toEngineInfo,
  toImage,
  toNetwork,
  toStatsSample,
  toVolume,
  volumesInUse,
} from '../../docker/objects.js';
import { dockerServer, leaseSsh, runProbe, withDockerClient, type DockerContext } from '../../docker/service.js';
import {
  MAX_STREAMS_PER_USER,
  activeDockerStreamCount,
  openDockerSse,
  pipeToSse,
  type DockerSse,
} from '../../docker/sse.js';

/**
 * Docker on a server, over its SSH connection (see docker/). Every route is
 * behind `requireAuth`, a capability gate from the §6 matrix
 * (docker/permissions.ts), and per-server access through `withDockerClient`
 * — a server the caller cannot access is a 404, one with Docker off a 400.
 *
 * This module holds the org settings, detection and the read routes (D1).
 * Later phases register their own route files under the same prefix
 * (docker-actions.ts, docker-exec.ts, docker-compose.ts, docker-fleet.ts) and
 * reuse what is exported here: {@link sendDockerError}, {@link dockerSseRoute}
 * and {@link serverParams}.
 */

/** Longest log tail served (lines). */
export const MAX_LOG_TAIL = 10_000;
const DEFAULT_LOG_TAIL = 500;
/** `/system/df` walks every layer and volume; it may not hold up the header. */
const DISK_USAGE_TIMEOUT_MS = 10_000;

const settingsSchema = z
  .object({
    operatorsCanExec: z.boolean().optional(),
    operatorsCanRemove: z.boolean().optional(),
    allowPrune: z.boolean().optional(),
    containerAlerts: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

/** `since`: unix seconds, or an ISO date. */
const sinceSchema = z
  .string()
  .refine((v) => /^\d+(\.\d+)?$/.test(v) || !Number.isNaN(Date.parse(v)), 'must be unix seconds or a date')
  .transform((v) => (/^\d+(\.\d+)?$/.test(v) ? v : String(Math.floor(Date.parse(v) / 1000))));

const logsSchema = z.object({
  follow: boolQuery,
  tail: z.coerce.number().int().min(0).max(MAX_LOG_TAIL).default(DEFAULT_LOG_TAIL),
  since: sinceSchema.optional(),
  timestamps: boolQuery,
});

const downloadSchema = logsSchema.omit({ follow: true }).extend({
  tail: z.coerce.number().int().min(0).max(MAX_LOG_TAIL).default(MAX_LOG_TAIL),
});

export const serverParams = z.object({ id: z.string().min(1) });
const containerParams = serverParams.extend({ cid: z.string() });
const imageParams = serverParams.extend({ iid: z.string() });

/**
 * Answer a Docker, credential or SSH failure with its own status and body
 * (`{ error, code?, hint? }`). Anything else is rethrown for the app's error
 * handler (a host key mismatch becomes its 409 there).
 */
export function sendDockerError(reply: FastifyReply, err: unknown) {
  if (err instanceof DockerError) return reply.status(err.statusCode).send(err.toJSON());
  if (err instanceof CredentialError) return reply.status(err.statusCode).send({ error: err.message });
  // Jump host failures carry their own status and a message safe to show
  if (err instanceof JumpHostError) return reply.status(err.statusCode).send({ error: err.message });
  throw err;
}

/**
 * A server-sent event route. `run` does whatever may still fail with a proper
 * HTTP status (inspect, the daemon request), then calls `open()` to start the
 * event stream and pumps into it. Errors before `open()` are answered as JSON;
 * errors after it arrive as an `error` event. The lease on the SSH connection
 * is held until `run` settles, and the stream is always ended.
 */
export async function dockerSseRoute(
  req: FastifyRequest,
  reply: FastifyReply,
  serverId: string,
  run: (ctx: DockerContext, open: () => DockerSse | null, signal: AbortSignal) => Promise<void>,
) {
  // Refuse before opening anything; openDockerSse checks again when it starts
  if (activeDockerStreamCount(req.user.id) >= MAX_STREAMS_PER_USER) {
    return reply
      .status(429)
      .send({ error: `Too many open Docker streams (at most ${MAX_STREAMS_PER_USER}); close a log or stats view first` });
  }
  // The browser leaving before the stream opens cancels the daemon request too
  const gone = new AbortController();
  reply.raw.on('close', () => gone.abort());

  let sse: DockerSse | null = null;
  const open = () => {
    sse = openDockerSse(req, reply, serverId);
    sse?.signal.addEventListener('abort', () => gone.abort(), { once: true });
    return sse;
  };
  try {
    await withDockerClient(req, serverId, (ctx) => run(ctx, open, gone.signal));
  } catch (err) {
    const stream = sse as DockerSse | null;
    if (stream) stream.fail(err);
    else if (!reply.sent && !gone.signal.aborted) return sendDockerError(reply, err);
  } finally {
    (sse as DockerSse | null)?.end();
  }
}

type RawJson = Record<string, unknown>;

/** Container inspect, for the few facts a route needs before streaming. */
async function inspectContainer(ctx: DockerContext, cid: string, signal?: AbortSignal): Promise<RawJson> {
  return ctx.docker.json<RawJson>({ path: apiPath('containers', cid, 'json'), signal });
}

/** Image references may hold `/` (registry, namespace): each part is encoded, the slashes kept. */
function imagePath(ref: string): string {
  return `/images/${ref.split('/').map(encodeURIComponent).join('/')}/json`;
}

/**
 * Turns a logs response into lines. Non-TTY containers multiplex stdout and
 * stderr (demux.ts); TTY ones send one raw stream. With timestamps, each line
 * starts with an RFC 3339 time and a space.
 */
export function logLineReader(tty: boolean, timestamps: boolean) {
  const demuxer = new Demuxer();
  const splitters: Record<'stdout' | 'stderr', LineSplitter> = { stdout: new LineSplitter(), stderr: new LineSplitter() };
  const toLine = (stream: 'stdout' | 'stderr', raw: string): DockerLogLine => {
    if (!timestamps) return { stream, text: raw };
    const space = raw.indexOf(' ');
    return space > 0 ? { stream, time: raw.slice(0, space), text: raw.slice(space + 1) } : { stream, text: raw };
  };
  const pick = (type: DockerStreamType) => (type === 'stderr' ? 'stderr' : 'stdout');
  return {
    push(chunk: Buffer): DockerLogLine[] {
      if (tty) return splitters.stdout.push(chunk).map((l) => toLine('stdout', l));
      const lines: DockerLogLine[] = [];
      for (const frame of demuxer.push(chunk)) {
        const stream = pick(frame.stream);
        for (const l of splitters[stream].push(frame.payload)) lines.push(toLine(stream, l));
      }
      return lines;
    },
    flush(): DockerLogLine[] {
      return (['stdout', 'stderr'] as const).flatMap((stream) => splitters[stream].flush().map((l) => toLine(stream, l)));
    },
  };
}

/** Newline-delimited JSON (stats, events) → parsed objects; a malformed line is skipped. */
function jsonLines(onObject: (value: RawJson) => void) {
  const splitter = new LineSplitter(1024 * 1024);
  const handle = (line: string) => {
    if (!line.trim()) return;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === 'object' && value !== null) onObject(value as RawJson);
    } catch {
      // partial or foreign line
    }
  };
  return {
    push: (chunk: Buffer) => splitter.push(chunk).forEach(handle),
    flush: () => splitter.flush().forEach(handle),
  };
}

function statusOf(req: FastifyRequest, row: typeof servers.$inferSelect): DockerServerStatus {
  return {
    serverId: row.id,
    serverName: row.name,
    docker: {
      mode: row.dockerMode as DockerMode,
      socketPath: row.dockerSocketPath,
      transport: row.dockerTransport as DockerTransport | null,
      detectedSocketPath: row.dockerDetectedSocketPath,
      detectedAt: row.dockerDetectedAt,
      version: row.dockerVersion,
      apiVersion: row.dockerApiVersion,
    },
    permissions: permissionsFor(req),
  };
}

export async function dockerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ── Org settings ──────────────────────────────────────────────

  /** The org's Docker permissions. Every member may read them — the UI hides what they cannot do. */
  app.get('/settings', async (req): Promise<DockerSettings> => dockerSettings(req.orgId));

  /** Owners and admins: what operators may do, and whether pruning is allowed. */
  app.patch('/settings', { preHandler: requireRole('admin') }, async (req): Promise<DockerSettings> => {
    const body = settingsSchema.parse(req.body);
    const before = dockerSettings(req.orgId);
    const after = updateDockerSettings(req.orgId, body);
    // Operators' container shells end when exec is taken away from them
    if (before.operatorsCanExec && !after.operatorsCanExec) closeDisallowedExecSessions(req.orgId);
    await audit(req, 'org.docker_settings', 'organization', req.orgId, undefined, { before, after });
    return after;
  });

  // ── Server status and detection ───────────────────────────────

  /** GET /servers/:id — Docker state and the caller's permissions; works with Docker off too. */
  app.get('/servers/:id', async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    if (!canAccessServer(req, id)) return reply.status(404).send({ error: 'Server not found' });
    const row = getDb()
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), eq(servers.orgId, req.orgId)))
      .get();
    if (!row) return reply.status(404).send({ error: 'Server not found' });
    return statusOf(req, row);
  });

  /** POST /servers/:id/probe — detect Docker now and record what was found (admin). */
  app.post('/servers/:id/probe', { preHandler: requireDocker('configure') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    try {
      const server = dockerServer(req, id);
      const lease = await leaseSsh(req, server);
      try {
        const result = await runProbe(lease.client, server);
        await audit(req, 'docker.probe', 'server', server.id, server.name, {
          ok: result.ok,
          ...(result.ok
            ? { transport: result.transport, socketPath: result.socketPath, version: result.version, apiVersion: result.apiVersion }
            : { problem: result.problem }),
        });
        return result;
      } finally {
        lease.release();
      }
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });

  // ── Read (D1) ─────────────────────────────────────────────────

  /** GET /servers/:id/info — engine facts and disk usage. */
  app.get('/servers/:id/info', { preHandler: requireDocker('view') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    try {
      return await withDockerClient(req, id, async (ctx): Promise<DockerEngineInfo> => {
        const [info, df] = await Promise.all([
          ctx.docker.json<RawJson>({ path: '/info' }),
          ctx.docker
            .json<RawJson>({ path: '/system/df', timeoutMs: DISK_USAGE_TIMEOUT_MS })
            .then((raw): DockerDiskUsage | null => toDiskUsage(raw))
            .catch(() => null),
        ]);
        return toEngineInfo(info, ctx.docker.apiVersion ?? '', ctx.endpoint, df);
      });
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });

  /** GET /servers/:id/containers?all=1 */
  app.get('/servers/:id/containers', { preHandler: requireDocker('view') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    const { all } = z.object({ all: boolQuery }).parse(req.query);
    try {
      return await withDockerClient(req, id, async (ctx): Promise<DockerContainer[]> => {
        const raw = await ctx.docker.json<RawJson[]>({ path: '/containers/json', query: { all } });
        return raw.map(toContainer);
      });
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });

  /** GET /servers/:id/containers/:cid — inspect, environment values redacted. */
  app.get('/servers/:id/containers/:cid', { preHandler: requireDocker('inspect') }, async (req, reply) => {
    const { id, cid } = containerParams.parse(req.params);
    try {
      const ref = containerRef(cid);
      return await withDockerClient(req, id, async (ctx) => redactInspect(await inspectContainer(ctx, ref)));
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });

  /** GET /servers/:id/containers/:cid/top — processes. */
  app.get('/servers/:id/containers/:cid/top', { preHandler: requireDocker('inspect') }, async (req, reply) => {
    const { id, cid } = containerParams.parse(req.params);
    try {
      const ref = containerRef(cid);
      return await withDockerClient(req, id, async (ctx): Promise<DockerTop> => {
        const raw = await ctx.docker.json<{ Titles?: unknown; Processes?: unknown }>({
          path: apiPath('containers', ref, 'top'),
        });
        return {
          titles: Array.isArray(raw.Titles) ? raw.Titles.map(String) : [],
          processes: Array.isArray(raw.Processes)
            ? raw.Processes.map((p) => (Array.isArray(p) ? p.map(String) : []))
            : [],
        };
      });
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });

  /**
   * GET /servers/:id/containers/:cid/logs?follow&tail&since&timestamps — SSE
   * of `{ type: 'logs', lines }` batches; `end` when the daemon closes (the
   * container stopped, or not following).
   */
  app.get('/servers/:id/containers/:cid/logs', { preHandler: requireDocker('inspect') }, async (req, reply) => {
    const { id, cid } = containerParams.parse(req.params);
    const query = logsSchema.parse(req.query);
    let ref: string;
    try {
      ref = containerRef(cid);
    } catch (err) {
      return sendDockerError(reply, err);
    }
    return dockerSseRoute(req, reply, id, async (ctx, open, signal) => {
      const info = await inspectContainer(ctx, ref, signal);
      const tty = (info.Config as { Tty?: unknown } | undefined)?.Tty === true;
      const res = await ctx.docker.stream({
        path: apiPath('containers', ref, 'logs'),
        query: {
          stdout: true,
          stderr: true,
          follow: query.follow,
          tail: query.tail,
          since: query.since,
          timestamps: query.timestamps,
        },
        signal,
      });
      const sse = open();
      if (!sse) return void res.destroy();
      const reader = logLineReader(tty, query.timestamps);
      await pipeToSse(
        res,
        sse,
        (chunk) => {
          const lines = reader.push(chunk);
          if (lines.length > 0) sse.send({ type: 'logs', lines });
        },
        () => {
          const rest = reader.flush();
          if (rest.length > 0) sse.send({ type: 'logs', lines: rest });
        },
      );
    });
  });

  /** GET /servers/:id/containers/:cid/logs/download?tail&since&timestamps — plain text, streamed. */
  app.get('/servers/:id/containers/:cid/logs/download', { preHandler: requireDocker('inspect') }, async (req, reply) => {
    const { id, cid } = containerParams.parse(req.params);
    const query = downloadSchema.parse(req.query);
    try {
      const ref = containerRef(cid);
      await withDockerClient(req, id, async (ctx) => {
        const info = await inspectContainer(ctx, ref);
        const tty = (info.Config as { Tty?: unknown } | undefined)?.Tty === true;
        const name = String(info.Name ?? ref).replace(/^\//, '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'container';
        const res = await ctx.docker.stream({
          path: apiPath('containers', ref, 'logs'),
          query: { stdout: true, stderr: true, tail: query.tail, since: query.since, timestamps: query.timestamps },
        });
        const demuxer = new Demuxer();
        const toText = new Transform({
          transform(chunk: Buffer, _enc, done) {
            if (tty) return done(null, chunk);
            for (const frame of demuxer.push(chunk)) this.push(frame.payload);
            done();
          },
        });
        reply.hijack();
        reply.raw.writeHead(200, {
          ...(reply.getHeaders() as Record<string, string>),
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}.log"`,
          'Cache-Control': 'no-store',
        });
        // Streamed from the daemon to the browser; nothing is buffered here
        await pipeline(res, toText, reply.raw).catch(() => {
          if (!reply.raw.writableEnded) reply.raw.destroy();
        });
      });
    } catch (err) {
      if (reply.raw.headersSent) {
        reply.raw.destroy();
        return;
      }
      return sendDockerError(reply, err);
    }
  });

  /** GET /servers/:id/containers/:cid/stats — SSE, one sample about every second, until the browser leaves. */
  app.get('/servers/:id/containers/:cid/stats', { preHandler: requireDocker('inspect') }, async (req, reply) => {
    const { id, cid } = containerParams.parse(req.params);
    let ref: string;
    try {
      ref = containerRef(cid);
    } catch (err) {
      return sendDockerError(reply, err);
    }
    return dockerSseRoute(req, reply, id, async (ctx, open, signal) => {
      const res = await ctx.docker.stream({ path: apiPath('containers', ref, 'stats'), query: { stream: true }, signal });
      const sse = open();
      if (!sse) return void res.destroy();
      const lines = jsonLines((raw) => sse.send({ type: 'stats', sample: toStatsSample(raw) }));
      await pipeToSse(res, sse, lines.push, lines.flush);
    });
  });

  /** GET /servers/:id/images */
  app.get('/servers/:id/images', { preHandler: requireDocker('view') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    try {
      return await withDockerClient(req, id, async (ctx): Promise<DockerImage[]> => {
        const [images, containers] = await Promise.all([
          ctx.docker.json<RawJson[]>({ path: '/images/json' }),
          ctx.docker.json<RawJson[]>({ path: '/containers/json', query: { all: true } }),
        ]);
        const inUse = imagesInUse(containers);
        return images.map((i) => toImage(i, inUse));
      });
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });

  /** GET /servers/:id/images/:iid — image inspect, environment values redacted. */
  app.get('/servers/:id/images/:iid', { preHandler: requireDocker('inspect') }, async (req, reply) => {
    const { id, iid } = imageParams.parse(req.params);
    try {
      const ref = imageRef(iid);
      return await withDockerClient(req, id, async (ctx) =>
        redactInspect(await ctx.docker.json<RawJson>({ path: imagePath(ref) })),
      );
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });

  /** GET /servers/:id/volumes */
  app.get('/servers/:id/volumes', { preHandler: requireDocker('view') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    try {
      return await withDockerClient(req, id, async (ctx): Promise<DockerVolume[]> => {
        const [volumes, containers] = await Promise.all([
          ctx.docker.json<{ Volumes?: RawJson[] | null }>({ path: '/volumes' }),
          ctx.docker.json<RawJson[]>({ path: '/containers/json', query: { all: true } }),
        ]);
        const inUse = volumesInUse(containers);
        return (volumes.Volumes ?? []).map((v) => toVolume(v, inUse));
      });
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });

  /** GET /servers/:id/networks */
  app.get('/servers/:id/networks', { preHandler: requireDocker('view') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    try {
      return await withDockerClient(req, id, async (ctx): Promise<DockerNetwork[]> => {
        const [networks, containers] = await Promise.all([
          ctx.docker.json<RawJson[]>({ path: '/networks' }),
          ctx.docker.json<RawJson[]>({ path: '/containers/json', query: { all: true } }),
        ]);
        const counts = containersPerNetwork(containers);
        return networks.map((n) => toNetwork(n, counts));
      });
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });

  /** GET /servers/:id/events — SSE of container, image, volume and network events; drives live lists. */
  app.get('/servers/:id/events', { preHandler: requireDocker('view') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    return dockerSseRoute(req, reply, id, async (ctx, open, signal) => {
      const res = await ctx.docker.stream({
        path: '/events',
        query: { filters: JSON.stringify({ type: ['container', 'image', 'volume', 'network'] }) },
        signal,
      });
      const sse = open();
      if (!sse) return void res.destroy();
      const lines = jsonLines((raw) => sse.send({ type: 'event', event: toEngineEvent(raw) }));
      await pipeToSse(res, sse, lines.push, lines.flush);
    });
  });
}
