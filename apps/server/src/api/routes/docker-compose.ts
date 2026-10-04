import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { DOCKER_COMPOSE_VERBS, type DockerComposeProject, type DockerComposeVerb, type DockerLogLine } from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { requireModule } from '../../auth/access/modules.js';
import { audit } from '../../audit/index.js';
import { boolQuery } from '../query.js';
import { DockerError } from '../../docker/errors.js';
import { requireDocker } from '../../docker/permissions.js';
import { apiPath } from '../../docker/validation.js';
import type { DockerContext } from '../../docker/service.js';
import { withDockerClient } from '../../docker/service.js';
import type { DockerSse } from '../../docker/sse.js';
import {
  claimProject,
  composeCommand,
  composeDisplay,
  discoverProjects,
  logSource,
  projectFilter,
  projectName,
  runCompose,
  serviceName,
} from '../../docker/compose.js';
import { MAX_LOG_TAIL, dockerSseRoute, logLineReader, sendDockerError, serverParams } from './docker.js';

/**
 * Compose projects on a server (D4), under `/api/docker/servers/:id/compose`.
 * Discovery reads container labels through the Engine API; actions run the
 * `docker compose` CLI over the caller's pooled SSH connection with every
 * argument quoted (docker/compose.ts). Gates follow the §6 matrix: listing is
 * `view`, logs are `inspect`, actions are `pull` (operators and up).
 *
 * An action keeps running when the browser leaves — a half-applied `up` is
 * worse than one nobody watched — and is audited with its exit code when it
 * ends. Revoking the caller's access closes the connection, and so the action.
 */

type RawJson = Record<string, unknown>;

/** Most containers merged into one project log stream. */
export const MAX_MERGED_CONTAINERS = 32;
const DEFAULT_COMPOSE_TAIL = 200;

const projectParams = serverParams.extend({ project: z.string() });
const actionParams = projectParams.extend({ verb: z.enum(DOCKER_COMPOSE_VERBS as [DockerComposeVerb, ...DockerComposeVerb[]]) });

const logsSchema = z.object({
  follow: boolQuery,
  tail: z.coerce.number().int().min(0).max(MAX_LOG_TAIL).default(DEFAULT_COMPOSE_TAIL),
  timestamps: boolQuery,
  service: z.string().optional(),
});

/** The project's containers (all states), straight from the daemon. */
async function projectContainers(ctx: DockerContext, project: string, signal?: AbortSignal): Promise<RawJson[]> {
  const raw = await ctx.docker.json<RawJson[]>({
    path: '/containers/json',
    query: { all: true, filters: projectFilter(project) },
    signal,
  });
  return raw;
}

/** One project, discovered from its labels; 404 when no container carries it. */
async function findProject(ctx: DockerContext, name: string, signal?: AbortSignal): Promise<DockerComposeProject> {
  const found = discoverProjects(await projectContainers(ctx, name, signal)).find((p) => p.name === name);
  if (!found) throw new DockerError('Compose project not found', 404);
  return found;
}

/**
 * Feed several daemon log responses into one event stream, each line tagged
 * with its source. Reading pauses while the browser is behind; every response
 * is destroyed when the stream ends. Sends `end` once all have ended.
 */
function mergeLogs(
  sources: Array<{ res: IncomingMessage; source: string; reader: ReturnType<typeof logLineReader> }>,
  sse: DockerSse,
): Promise<void> {
  return new Promise((resolve) => {
    let open = sources.length;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      sse.signal.removeEventListener('abort', stop);
      resolve();
    };
    const stop = () => {
      for (const { res } of sources) res.destroy();
      finish();
    };
    if (sse.signal.aborted || open === 0) {
      if (!sse.closed) sse.send({ type: 'end' });
      return stop();
    }
    sse.signal.addEventListener('abort', stop, { once: true });

    const tag = (source: string, lines: DockerLogLine[]) => lines.map((l) => ({ ...l, source }));
    let paused = false;
    const pauseAll = () => {
      if (paused) return;
      paused = true;
      for (const { res } of sources) res.pause();
      sse.onDrain(() => {
        paused = false;
        for (const { res } of sources) res.resume();
      });
    };

    for (const { res, source, reader } of sources) {
      let ended = false;
      const done = (failure?: string) => {
        if (ended) return;
        ended = true;
        if (!sse.closed) {
          const rest = reader.flush();
          if (rest.length > 0) sse.send({ type: 'logs', lines: tag(source, rest) });
          if (failure) sse.send({ type: 'logs', lines: [{ stream: 'stderr', source, text: `— ${failure} —` }] });
        }
        if (--open === 0) {
          if (!sse.closed) sse.send({ type: 'end' });
          finish();
        }
      };
      res.on('data', (chunk: Buffer) => {
        if (sse.closed) return;
        const lines = reader.push(chunk);
        if (lines.length > 0) sse.send({ type: 'logs', lines: tag(source, lines) });
        if (sse.backpressured) pauseAll();
      });
      res.on('end', () => done());
      res.on('error', (err) => done(`log stream failed: ${err.message}`));
      res.on('close', () => done(sse.closed ? undefined : 'log stream closed'));
    }
  });
}

export async function dockerComposeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  // Docker on one server is the server's Docker tab: the Servers module (unified roles spec §3.1)
  app.addHook('preHandler', requireModule('servers'));

  /** GET /servers/:id/compose — projects with their services and state. */
  app.get('/servers/:id/compose', { preHandler: requireDocker('view') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    try {
      return await withDockerClient(req, id, async (ctx): Promise<DockerComposeProject[]> => {
        const raw = await ctx.docker.json<RawJson[]>({
          path: '/containers/json',
          query: { all: true, filters: projectFilter() },
        });
        return discoverProjects(raw);
      });
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });

  /**
   * POST /servers/:id/compose/:project/:verb — `up -d`, `down`, `pull` or
   * `restart`. SSE: the CLI's output as `logs` batches, then `exit` with the
   * status, then `end`. Answers 404 for an unknown project, 409 when its
   * labels are unusable or another action on it is running.
   */
  app.post('/servers/:id/compose/:project/:verb', { preHandler: requireDocker('pull') }, async (req, reply) => {
    const { id, project, verb } = actionParams.parse(req.params);
    let name: string;
    try {
      name = projectName(project);
    } catch (err) {
      return sendDockerError(reply, err);
    }
    return dockerSseRoute(req, reply, id, async (ctx, open, signal) => {
      const found = await findProject(ctx, name, signal);
      if (found.unmanageable) throw new DockerError(`Cannot run compose for this project: ${found.unmanageable}`, 409);
      const command = composeCommand({ project: found, socketPath: ctx.endpoint.socketPath }, verb);
      const release = claimProject(ctx.server.id, name);
      if (!release) throw new DockerError('Another compose action is running for this project', 409);
      try {
        const sse = open();
        if (!sse) return;
        const meta = {
          project: name,
          workingDir: found.workingDir,
          configFiles: found.configFiles,
          command: composeDisplay(found, verb),
        };
        let result;
        try {
          result = await runCompose(ctx.ssh, command, {
            onLines: (stream, lines) => sse.send({ type: 'logs', lines: lines.map((text) => ({ stream, text })) }),
          });
        } catch (err) {
          await audit(req, `docker.compose_${verb}`, 'server', ctx.server.id, ctx.server.name, {
            ...meta,
            exitCode: null,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
        await audit(req, `docker.compose_${verb}`, 'server', ctx.server.id, ctx.server.name, {
          ...meta,
          exitCode: result.exitCode,
          ...(result.signal && { signal: result.signal }),
          ...(result.timedOut && { timedOut: true }),
          // The browser left before the end; the action ran to completion anyway
          ...(sse.closed && { detached: true }),
          durationMs: result.durationMs,
        });
        sse.send({ type: 'exit', ...result });
        sse.send({ type: 'end' });
      } finally {
        release();
      }
    });
  });

  /**
   * GET /servers/:id/compose/:project/logs?follow&tail&timestamps&service —
   * SSE of `logs` batches merged from the project's containers, each line
   * tagged with its source (`web-1`). `tail` applies per container.
   */
  app.get('/servers/:id/compose/:project/logs', { preHandler: requireDocker('inspect') }, async (req, reply) => {
    const { id, project } = projectParams.parse(req.params);
    const query = logsSchema.parse(req.query);
    let name: string;
    let service: string | undefined;
    try {
      name = projectName(project);
      service = query.service === undefined ? undefined : serviceName(query.service);
    } catch (err) {
      return sendDockerError(reply, err);
    }
    return dockerSseRoute(req, reply, id, async (ctx, open, signal) => {
      const found = await findProject(ctx, name, signal);
      const targets = found.services
        .filter((s) => !service || s.name === service)
        .flatMap((s) => s.containers.map((c) => ({ id: c.id, source: logSource(s.name, c) })));
      if (targets.length === 0) throw new DockerError('No such service in this project', 404);
      if (targets.length > MAX_MERGED_CONTAINERS) {
        throw new DockerError(`The project has more than ${MAX_MERGED_CONTAINERS} containers; pick a service`, 400);
      }

      const opened = await Promise.allSettled(
        targets.map(async (t) => {
          const info = await ctx.docker.json<RawJson>({ path: apiPath('containers', t.id, 'json'), signal });
          const tty = (info.Config as { Tty?: unknown } | undefined)?.Tty === true;
          const res = await ctx.docker.stream({
            path: apiPath('containers', t.id, 'logs'),
            query: { stdout: true, stderr: true, follow: query.follow, tail: query.tail, timestamps: query.timestamps },
            signal,
          });
          return { res, source: t.source, reader: logLineReader(tty, query.timestamps) };
        }),
      );
      const sources = opened.flatMap((o) => (o.status === 'fulfilled' ? [o.value] : []));
      const failed = opened.find((o): o is PromiseRejectedResult => o.status === 'rejected');
      if (failed) {
        // All or nothing: the ones that did open are closed again
        for (const s of sources) s.res.destroy();
        throw failed.reason;
      }
      const sse = open();
      if (!sse) {
        for (const s of sources) s.res.destroy();
        return;
      }
      await mergeLogs(sources, sse);
    });
  });
}
