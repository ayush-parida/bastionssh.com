import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import {
  DEPLOY_ENV_KEY_PATTERN,
  DEPLOY_NAME_PATTERN,
  type AuditAction,
  type DeployAppStatus,
  type DeployAppSummary,
  type DeployEnvKeys,
  type DeployEnvReveal,
  type DeployLogLine,
  type DeployOutcome,
  type DeployRelease,
  type DeployServerState,
  type DeploySetupResult,
  type DeployValidation,
} from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { requireModule } from '../../auth/access/modules.js';
import { requireServer } from '../../auth/server-access.js';
import { passkeyCount, requireBrowserSession, STEP_UP_MESSAGE } from '../../auth/passkey.js';
import { audit } from '../../audit/index.js';
import { config } from '../../config/index.js';
import { boolQuery } from '../query.js';
import { MAX_STREAMS_PER_USER, activeStreamCount } from '../sse.js';
import { bastionctlInfo } from '../../deploy/bundle.js';
import { DeployError } from '../../deploy/errors.js';
import { discoverRoot, installBastionctl, integrity, prepareRoot, requireBundle } from '../../deploy/install.js';
import type { RunResult } from '../../deploy/remote.js';
import { actorLabel, bastionctlCommand, DEPLOY_TIMEOUT_MS, parseResult, SETUP_TIMEOUT_MS } from '../../deploy/runner.js';
import { contextFor, sendDeployError, withDeploy, withRemote, type DeployContext } from '../../deploy/service.js';
import { openDeploySse, TOO_MANY_STREAMS, type DeploySse } from '../../deploy/sse.js';
import { detectNginx, existingProxyMode, uploadHelper } from '../../deploy/nginx.js';
import { deployDomainRoutes, syncProxy } from './deploy-domains.js';

/**
 * Server-side deployments (deployments spec §7), under
 * `/api/deploy/servers/:id`. Every route needs the Deployments module and a
 * level on the server (spec §2.7): `view` lists apps, releases, status and
 * config; `operate` deploys, rolls back, restarts and stops; `manage` sets
 * the server up, writes `bastion.yml` and `.env`, and deletes apps.
 *
 * Nothing about apps is stored here: each request reads the server through
 * bastionctl (deploy/service.ts checks it is the one we ship first), and the
 * only rows written are audit entries — `.env` changes and reveals record
 * variable names, never values. Uploads stream through to `<root>/tmp` on
 * the server; deploy and rollback logs stream back as SSE. Like compose
 * actions, a deploy keeps running when the browser leaves (a half-switched
 * release is worse than one nobody watched) and is audited when it ends.
 */

const serverParams = z.object({ id: z.string().min(1) });
const appParams = serverParams.extend({ app: z.string().regex(DEPLOY_NAME_PATTERN, 'Invalid app name') });
const envParams = appParams.extend({ key: z.string().regex(DEPLOY_ENV_KEY_PATTERN, 'Invalid variable name') });
const rollbackBody = z.object({ release: z.string().regex(DEPLOY_NAME_PATTERN, 'Invalid release id') }).strict();
const configBody = z.object({ text: z.string().max(64 * 1024) }).strict();
const envBody = z.object({ value: z.string().max(64 * 1024) }).strict();
const deleteQuery = z.object({ purge: boolQuery });
const setupBody = z.object({ proxy: z.enum(['caddy', 'nginx']).optional() }).strict();

/** How often buffered log lines are sent. */
const LOG_FLUSH_MS = 100;
const MAX_CONFIG_BYTES = 64 * 1024;

type Level = 'view' | 'operate' | 'manage';

/** Module level, then the server level (404 for one the caller cannot reach). The plugin hook already needs the module at `view`. */
function gate(level: Level) {
  const server = requireServer(`deploy_${level}`);
  return level === 'view' ? [server] : [requireModule('deployments', level), server];
}

const tmpName = (root: string, prefix: string, ext: string) => `${root}/tmp/${prefix}-${randomBytes(12).toString('hex')}${ext}`;

/**
 * A failure as the audit records it: its first line only. Deploy errors end
 * with the app's last log lines (health check, crash), and an app may print
 * its own secrets there; the full text stays in the release's build.log on
 * the server.
 */
export function auditError(message: string | null | undefined): string | null {
  if (!message) return null;
  return message.split('\n')[0]!.slice(0, 300);
}

function auditDeploy(req: FastifyRequest, action: AuditAction, ctx: Pick<DeployContext, 'server'>, metadata: Record<string, unknown>) {
  return audit(req, action, 'server', ctx.server.id, ctx.server.name, metadata);
}

/**
 * Run a long bastionctl command (deploy, rollback) into an event stream:
 * its progress as `log` batches, then `result` (or `error`), `exit` and
 * `end`. Returns the outcome for the audit; the command runs to its end even
 * when the browser has left.
 */
async function streamCommand(
  req: FastifyRequest,
  ctx: DeployContext,
  sse: DeploySse,
  args: string[],
  /** Runs after a successful outcome, before the stream ends; its lines join the log. */
  after?: (log: (line: string) => void) => Promise<unknown>,
): Promise<{ outcome: DeployOutcome | null; error: string | null; result: RunResult }> {
  let pending: DeployLogLine[] = [];
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    if (pending.length === 0) return;
    const lines = pending;
    pending = [];
    sse.send({ type: 'log', lines });
  };
  const result = await ctx.remote.run(bastionctlCommand(ctx.root, args, actorLabel(req.user)), {
    timeoutMs: DEPLOY_TIMEOUT_MS,
    onLine: (stream, text) => {
      // stdout carries only the JSON result
      if (stream !== 'stderr' || sse.closed) return;
      pending.push({ stream, text });
      if (pending.length >= 200) flush();
      else timer ??= setTimeout(flush, LOG_FLUSH_MS);
    },
  });
  if (timer) clearTimeout(timer);
  flush();
  const parsed = parseResult(result.stdout) as (DeployOutcome & { error?: string | null }) | { error: string } | null;
  let outcome: DeployOutcome | null = null;
  let error: string | null = null;
  if (parsed && 'release' in parsed) {
    outcome = parsed;
    if (outcome.result === 'success' && after) {
      const log = (text: string) => sse.send({ type: 'log', lines: [{ stream: 'stderr', text }] });
      // The release is live: whatever follows must not hide its result (or skip the finish audit)
      await after(log).catch((err: Error) => log(`warning: ${err.message}`));
    }
    sse.send({ type: 'result', outcome });
  } else {
    error = parsed?.error ?? (result.timedOut ? 'The command did not finish in time' : 'The command ended without a result (connection lost?)');
    sse.send({ type: 'error', error });
  }
  sse.send({ type: 'exit', exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, timedOut: result.timedOut });
  sse.send({ type: 'end' });
  return { outcome, error, result };
}

export async function deployRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireModule('deployments'));
  // Only this plugin parses multipart (deploy uploads), one file, streamed
  await app.register(multipart, { limits: { files: 1, fields: 0, parts: 1, fileSize: config.sftpMaxUploadBytes } });

  /** GET /bastionctl — the version this BastionSSH installs, and its SHA-256. */
  app.get('/bastionctl', async (_req, reply) => {
    try {
      return bastionctlInfo(requireBundle());
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /** GET /servers/:id — where deployments live on the server and whether its bastionctl is ours. */
  app.get('/servers/:id', { preHandler: gate('view') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    try {
      const bundle = requireBundle();
      return await withRemote(req, id, async (remote): Promise<DeployServerState> => {
        const root = await discoverRoot(remote);
        return { root, integrity: root ? await integrity(remote, root, bundle) : 'missing', version: bundle.version };
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /**
   * POST /servers/:id/setup — create the root directory, install (or
   * reinstall) bastionctl, then `bastionctl setup`: network, proxy, folders.
   * `{ proxy }` picks the mode; by default a server keeps the mode it was set
   * up with, and a first setup picks nginx when the host's nginx owns ports
   * 80/443 (spec §6), uploading the helper an administrator then installs.
   */
  app.post('/servers/:id/setup', { preHandler: gate('manage') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    const { proxy: requested } = setupBody.parse(req.body ?? {});
    try {
      const bundle = requireBundle();
      return await withRemote(req, id, async (remote) => {
        const prepared = await prepareRoot(remote);
        const base = { root: prepared.root, version: bundle.version, sudo: prepared.sudo };
        try {
          if (!prepared.docker) throw new DeployError('Docker is not installed on this server. Install Docker Engine, then set up again.', 409, 'docker_missing');
          if (prepared.socket === 'missing') throw new DeployError('Docker is installed but not running (no /var/run/docker.sock).', 409, 'docker_missing');
          if (prepared.socket === 'denied') {
            throw new DeployError(
              `The SSH user cannot use Docker. Add it to the docker group (sudo usermod -aG docker ${remote.server.username}) or allow passwordless sudo for docker.`,
              409,
              'docker_denied',
            );
          }
          await installBastionctl(remote, prepared.root, bundle);
          const ctx = contextFor(req, remote, prepared.root);
          const proxy = requested ?? (await existingProxyMode(remote, prepared.root)) ?? ((await detectNginx(remote, bundle)).detected ? 'nginx' : 'caddy');
          if (proxy === 'nginx') await uploadHelper(remote, prepared.root, bundle);
          const { value } = await ctx.run<DeploySetupResult>(['setup', '--proxy', proxy], { timeoutMs: SETUP_TIMEOUT_MS });
          await auditDeploy(req, 'deploy.setup', ctx, { ...base, docker: prepared.socket, proxy, result: 'success' });
          return { ...value, sudo: prepared.sudo, socket: prepared.socket };
        } catch (err) {
          await audit(req, 'deploy.setup', 'server', remote.server.id, remote.server.name, { ...base, result: 'failed', error: auditError((err as Error).message) });
          throw err;
        }
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /** GET /servers/:id/apps — every app with its current release and container. */
  app.get('/servers/:id/apps', { preHandler: gate('view') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    try {
      return await withDeploy(req, id, async (ctx) => (await ctx.run<DeployAppSummary[]>(['list'])).value);
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /** GET /servers/:id/apps/:app — one app in detail. */
  app.get('/servers/:id/apps/:app', { preHandler: gate('view') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    try {
      return await withDeploy(req, id, async (ctx) => (await ctx.run<DeployAppStatus>(['status', name])).value);
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /** GET /servers/:id/apps/:app/releases — newest first. */
  app.get('/servers/:id/apps/:app/releases', { preHandler: gate('view') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    try {
      return await withDeploy(req, id, async (ctx) => (await ctx.run<DeployRelease[]>(['releases', name])).value);
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /** GET /servers/:id/apps/:app/config — bastion.yml as written (it holds no secrets). */
  app.get('/servers/:id/apps/:app/config', { preHandler: gate('view') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    try {
      return await withDeploy(req, id, async (ctx) => {
        const text = await ctx.remote.readFile(`${ctx.root}/apps/${name}/bastion.yml`, MAX_CONFIG_BYTES);
        if (text === null) throw new DeployError(`No app named ${name} on this server`, 404);
        return { text: text.toString('utf8') };
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /**
   * PUT /servers/:id/apps/:app/config — validate with bastionctl (422 with
   * every problem), then write it; a new name creates the app.
   */
  app.put('/servers/:id/apps/:app/config', { preHandler: gate('manage') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    const { text } = configBody.parse(req.body);
    try {
      return await withDeploy(req, id, async (ctx) => {
        const file = tmpName(ctx.root, 'config', '.yml');
        await ctx.remote.writeFile(file, text, 0o600);
        try {
          const { value: validation } = await ctx.run<DeployValidation>(['validate', name, '--file', file], { allowFailure: true });
          if (!validation.ok) {
            throw new DeployError('The config is not valid', 422, 'invalid_config', { errors: validation.errors ?? [] });
          }
          const { value } = await ctx.run<{ app: string; created: boolean }>(['init', name, '--config', file, '--force']);
          await auditDeploy(req, 'deploy.config_update', ctx, { app: name, created: value.created });
          const proxy = await syncProxy(req, ctx, name, 'apply');
          return proxy ? { ...value, proxy } : value;
        } finally {
          await ctx.remote.remove(file);
        }
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /**
   * POST /servers/:id/apps/:app/deploy — multipart/form-data with one file
   * field `source` (.tar or .tar.gz), streamed to `<root>/tmp` on the
   * server. SSE: `log` batches, then `result`, `exit` and `end`.
   */
  app.post('/servers/:id/apps/:app/deploy', { preHandler: gate('operate') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    if (!req.isMultipart()) return reply.status(400).send({ error: 'Send the source as multipart/form-data, in a file field named "source"' });
    return sseRoute(req, reply, id, async (ctx, open) => {
      const part = await req.file();
      if (!part || part.fieldname !== 'source') throw new DeployError('Send the source in a file field named "source"', 400);
      const upload = tmpName(ctx.root, 'upload', '.tar.gz');
      try {
        const bytes = await ctx.remote.upload(upload, part.file, config.sftpMaxUploadBytes);
        if (part.file.truncated) throw new DeployError('The upload is too large', 413);
        const sse = open();
        if (!sse) return;
        await auditDeploy(req, 'deploy.start', ctx, { app: name, bytes });
        // nginx mode: the host's server block (and certificate) follow the first deploy and domain changes
        const { outcome, error, result } = await streamCommand(req, ctx, sse, ['deploy', name, '--source', upload], (log) => syncProxy(req, ctx, name, 'apply', log));
        await auditDeploy(req, 'deploy.finish', ctx, {
          app: name,
          release: outcome?.release ?? null,
          result: outcome?.result ?? 'failed',
          error: auditError(outcome?.error ?? error),
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          ...(result.timedOut && { timedOut: true }),
          // The browser left before the end; the deploy ran to completion anyway
          ...(sse.closed && { detached: true }),
        });
      } finally {
        // Moved into the release on success; anything left is ours to clean up
        await ctx.remote.remove(upload);
      }
    });
  });

  /** POST /servers/:id/apps/:app/rollback — `{ release }`; serve a kept release again. SSE like deploy. */
  app.post('/servers/:id/apps/:app/rollback', { preHandler: gate('operate') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    const { release } = rollbackBody.parse(req.body);
    return sseRoute(req, reply, id, async (ctx, open) => {
      const sse = open();
      if (!sse) return;
      const { outcome, error, result } = await streamCommand(req, ctx, sse, ['rollback', name, release]);
      await auditDeploy(req, 'deploy.rollback', ctx, {
        app: name,
        release,
        previous: outcome?.previous ?? null,
        result: outcome?.result ?? 'failed',
        error: auditError(outcome?.error ?? error),
        exitCode: result.exitCode,
        ...(sse.closed && { detached: true }),
      });
    });
  });

  for (const action of ['restart', 'stop'] as const) {
    /** POST /servers/:id/apps/:app/restart | stop — the live container. */
    app.post(`/servers/:id/apps/:app/${action}`, { preHandler: gate('operate') }, async (req, reply) => {
      const { id, app: name } = appParams.parse(req.params);
      try {
        return await withDeploy(req, id, async (ctx) => {
          const { value } = await ctx.run<{ app: string; container: string }>([action, name]);
          await auditDeploy(req, `deploy.${action}`, ctx, { app: name, container: value.container });
          return value;
        });
      } catch (err) {
        return sendDeployError(reply, err);
      }
    });
  }

  /** DELETE /servers/:id/apps/:app?purge — containers, images and releases; with purge also config, .env and volumes. */
  app.delete('/servers/:id/apps/:app', { preHandler: gate('manage') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    const { purge } = deleteQuery.parse(req.query);
    try {
      return await withDeploy(req, id, async (ctx) => {
        const { value } = await ctx.run<{ app: string; purged: boolean }>(['delete', name, ...(purge ? ['--purge'] : [])]);
        await auditDeploy(req, 'deploy.delete', ctx, { app: name, purge });
        const proxy = await syncProxy(req, ctx, name, 'remove');
        return proxy ? { ...value, proxy } : value;
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  // ── .env: names listed, values write-only, reveal behind a passkey ──────────

  app.get('/servers/:id/apps/:app/env', { preHandler: gate('manage') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    try {
      return await withDeploy(req, id, async (ctx) => (await ctx.run<DeployEnvKeys>(['env', 'keys', name])).value);
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /** PUT /servers/:id/apps/:app/env/:key — `{ value }`, handed to bastionctl on stdin, never on a command line. */
  app.put('/servers/:id/apps/:app/env/:key', { preHandler: gate('manage') }, async (req, reply) => {
    const { id, app: name, key } = envParams.parse(req.params);
    const { value } = envBody.parse(req.body);
    try {
      return await withDeploy(req, id, async (ctx) => {
        const { value: result } = await ctx.run<{ key: string; changed: boolean }>(['env', 'set', name, key], { stdin: value });
        await auditDeploy(req, 'deploy.env_set', ctx, { app: name, key, changed: result.changed });
        return result;
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  app.delete('/servers/:id/apps/:app/env/:key', { preHandler: gate('manage') }, async (req, reply) => {
    const { id, app: name, key } = envParams.parse(req.params);
    try {
      return await withDeploy(req, id, async (ctx) => {
        const { value: result } = await ctx.run<{ key: string; changed: boolean }>(['env', 'unset', name, key]);
        await auditDeploy(req, 'deploy.env_unset', ctx, { app: name, key, changed: result.changed });
        return result;
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /**
   * POST /servers/:id/apps/:app/env/:key/reveal — one value, from a browser
   * session that has just confirmed a passkey (step-up), as for Docker env
   * reveal. Audited with the variable name.
   */
  app.post('/servers/:id/apps/:app/env/:key/reveal', { preHandler: gate('manage') }, async (req, reply) => {
    const { id, app: name, key } = envParams.parse(req.params);
    if (!requireBrowserSession(req, reply, 'Secret values are revealed from a signed-in browser, not with an API token')) return reply;
    if (!req.passkeyVerified) {
      if (passkeyCount(req.user.id) === 0) {
        return reply.status(403).send({
          error: 'Revealing secret values needs a passkey. Add one under Settings → Passkeys, then try again.',
          code: 'DEPLOY_REVEAL_NEEDS_PASSKEY',
        });
      }
      return reply.status(403).send({ error: STEP_UP_MESSAGE, code: 'PASSKEY_STEP_UP_REQUIRED' });
    }
    try {
      return await withDeploy(req, id, async (ctx): Promise<DeployEnvReveal> => {
        const { value } = await ctx.run<DeployEnvReveal>(['env', 'get', name, key]);
        await auditDeploy(req, 'deploy.env_reveal', ctx, { app: name, key });
        return { key, value: value.value };
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  // Domains, TLS and the nginx helper (spec §6)
  await app.register(deployDomainRoutes, { gate });
}

/**
 * A streaming route: `run` does what may still fail with a proper HTTP status
 * (discovery, integrity, the upload), then calls `open()` and streams. Errors
 * before `open()` are answered as JSON, after it as an `error` event.
 */
async function sseRoute(
  req: FastifyRequest,
  reply: FastifyReply,
  serverId: string,
  run: (ctx: DeployContext, open: () => DeploySse | null) => Promise<void>,
) {
  if (activeStreamCount(req.user.id) >= MAX_STREAMS_PER_USER) return reply.status(429).send({ error: TOO_MANY_STREAMS });
  let sse: DeploySse | null = null;
  const open = () => (sse = openDeploySse(req, reply, serverId));
  try {
    await withDeploy(req, serverId, (ctx) => run(ctx, open));
  } catch (err) {
    const stream = sse as DeploySse | null;
    if (stream) stream.fail(err);
    else if (!reply.sent) return sendDeployError(reply, err);
  } finally {
    (sse as DeploySse | null)?.end();
  }
}
