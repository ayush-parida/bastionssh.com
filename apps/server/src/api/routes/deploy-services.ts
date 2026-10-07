import { finished } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import {
  DEPLOY_NAME_PATTERN,
  SERVICE_BACKUP_FILE,
  defaultServiceVersion,
  serviceConfigYaml,
  serviceConnectionDetails,
  serviceFixedEnv,
  serviceTemplate,
  serviceUpgradeAllowed,
  serviceVersion,
  serviceVersionOfImage,
  type AuditAction,
  type DeployAppStatus,
  type DeployBackupList,
  type DeployBackupResult,
  type DeployEnvGenerated,
  type DeployLogLine,
  type DeployOutcome,
  type DeployRestoreResult,
  type DeployServiceConnection,
  type DeployValidation,
  type ServiceTemplate,
} from '@smt/shared';
import { audit } from '../../audit/index.js';
import { passkeyCount, requireBrowserSession, STEP_UP_MESSAGE } from '../../auth/passkey.js';
import { DeployError } from '../../deploy/errors.js';
import { existingProxyMode } from '../../deploy/nginx.js';
import type { RunResult } from '../../deploy/remote.js';
import { sendDeployError, withDeploy, type DeployContext } from '../../deploy/service.js';
import type { DeploySse } from '../../deploy/sse.js';
import type { StreamReservation } from '../sse.js';
import { syncProxy } from './deploy-domains.js';

/**
 * Quick services (services spec §3.3, §3.4), under
 * `/api/deploy/servers/:id`: create one from the catalog, its connection
 * details, Update version, and backups. Like every deployments route, the
 * server holds everything — the service's bastion.yml, its generated
 * secrets (bastionctl writes them; BastionSSH never sees a value unless a
 * member reveals one) and its backups; the only rows written here are audit
 * entries.
 *
 * Levels (Deployments module and the server, the lower of both): view sees
 * connection details (secrets masked) and the backups; operate backs up now;
 * manage creates, updates the version, restores, deletes backups, changes
 * the schedule and downloads (with a passkey step-up, like a reveal).
 */

type Level = 'view' | 'operate' | 'manage';

export interface ServiceRouteHelpers {
  gate: (level: Level) => preHandlerHookHandler[];
  sseRoute: (
    req: FastifyRequest,
    reply: FastifyReply,
    serverId: string,
    run: (ctx: DeployContext, open: () => DeploySse | null, slot: StreamReservation) => Promise<void>,
  ) => Promise<unknown>;
  streamCommand: (
    req: FastifyRequest,
    ctx: DeployContext,
    sse: DeploySse,
    args: string[],
    after?: (log: (line: string) => void) => Promise<unknown>,
  ) => Promise<{ outcome: DeployOutcome | null; error: string | null; result: RunResult }>;
  auditError: (message: string | null | undefined) => string | null;
}

const serverParams = z.object({ id: z.string().min(1) });
const appParams = serverParams.extend({ app: z.string().regex(DEPLOY_NAME_PATTERN, 'Invalid app name') });
const fileParams = appParams.extend({ file: z.string().regex(SERVICE_BACKUP_FILE, 'Invalid backup file') });
const MEMORY = /^([1-9]\d{0,5})([mg])$/;
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

const createBody = z
  .object({
    name: z.string().regex(DEPLOY_NAME_PATTERN, 'Use a-z, 0-9 and -, starting with a letter or digit (at most 41)'),
    template: z.string().min(1).max(64),
    version: z.string().min(1).max(32).optional(),
    memory: z.string().regex(MEMORY, 'Like 512m or 1g').optional(),
    publish: z
      .object({ scope: z.enum(['none', 'localhost', 'public']), port: z.number().int().min(1024).max(65535).optional() })
      .strict()
      .optional(),
    domain: z.string().regex(DOMAIN, 'A domain like db-admin.example.com (lower case)').nullable().optional(),
    tls: z.enum(['auto', 'staging', 'internal']).optional(),
  })
  .strict();
const versionBody = z.object({ version: z.string().min(1).max(32) }).strict();
const restoreBody = z.object({ confirm: z.string().max(64) }).strict();
const scheduleBody = z.object({ schedule: z.enum(['off', 'hourly', 'daily']), keep: z.number().int().min(1).max(100).optional() }).strict();

/** A dump or a restore of a large database can take a while. */
const BACKUP_TIMEOUT_MS = 2 * 60 * 60_000;
/** set-image and backups schedule edit bastion.yml; ensuring bastion-cron may pull nothing (the Node.js image is there). */
const EDIT_TIMEOUT_MS = 2 * 60_000;

const bytesOf = (m: string) => Number(MEMORY.exec(m)![1]) * (MEMORY.exec(m)![2] === 'g' ? 1024 : 1);

function auditService(req: FastifyRequest, action: AuditAction, ctx: Pick<DeployContext, 'server'>, metadata: Record<string, unknown>) {
  return audit(req, action, 'server', ctx.server.id, ctx.server.name, metadata);
}

/** The app's status, its config, and the catalog template it was created from (404 for an app that is no quick service). */
async function serviceOf(ctx: DeployContext, app: string): Promise<{ status: DeployAppStatus; template: ServiceTemplate }> {
  const { value: status } = await ctx.run<DeployAppStatus>(['status', app]);
  if (!status.config) throw new DeployError(`bastion.yml of ${app} is not valid: ${status.configError ?? 'unreadable'}`, 409, 'invalid_config');
  const template = serviceTemplate(status.config.service);
  if (!status.config.service) throw new DeployError(`${app} is not a quick service (its bastion.yml has no service:)`, 404, 'not_a_service');
  if (!template) throw new DeployError(`${app} is a ${status.config.service} service, which this BastionSSH does not know`, 404, 'unknown_service');
  return { status, template };
}

/** Downloads, like reveals, need a browser session that has just confirmed a passkey. False when the answer was sent. */
function requireStepUp(req: FastifyRequest, reply: FastifyReply, what: string): boolean {
  if (!requireBrowserSession(req, reply, `${what} from a signed-in browser, not with an API token`)) return false;
  if (req.passkeyVerified) return true;
  if (passkeyCount(req.user.id) === 0) {
    reply.status(403).send({ error: `${what} needs a passkey. Add one under Settings → Passkeys, then try again.`, code: 'DEPLOY_REVEAL_NEEDS_PASSKEY' });
    return false;
  }
  reply.status(403).send({ error: STEP_UP_MESSAGE, code: 'PASSKEY_STEP_UP_REQUIRED' });
  return false;
}

export async function deployServiceRoutes(app: FastifyInstance, helpers: ServiceRouteHelpers) {
  const { gate, sseRoute, streamCommand, auditError } = helpers;

  /** Lines in the create or update log, before bastionctl's own. */
  const say = (sse: DeploySse, ...texts: string[]) => sse.send({ type: 'log', lines: texts.map((text): DeployLogLine => ({ stream: 'stderr', text })) });

  /** Deploy (pull and start) a service, streamed, audited as any deploy is. */
  async function deployStreamed(req: FastifyRequest, ctx: DeployContext, sse: DeploySse, name: string, image: string) {
    await auditService(req, 'deploy.start', ctx, { app: name, image });
    const streamed = await streamCommand(req, ctx, sse, ['deploy', name], (log) => syncProxy(req, ctx, name, 'apply', log));
    const { outcome, error, result } = streamed;
    await auditService(req, 'deploy.finish', ctx, {
      app: name,
      release: outcome?.release ?? null,
      result: outcome?.result ?? 'failed',
      error: auditError(outcome?.error ?? error),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(result.timedOut && { timedOut: true }),
      ...(sse.closed && { detached: true }),
    });
    return streamed;
  }

  /**
   * POST /servers/:id/services — a quick service from the catalog:
   * `{ name, template, version?, memory?, publish?, domain?, tls? }`. Its
   * bastion.yml is made from the template (pinned image, recreate with
   * exclusive volumes, health check, publish, a domain for a UI) and
   * validated by bastionctl (422 with every problem); the fixed `.env`
   * values are set and every secret generated on the server (`env generate
   * --if-missing`: a service created again keeps its credentials). Then it
   * is deployed, the log streamed as for a deploy. Audited as
   * `deploy.service_create`, then `deploy.start` / `deploy.finish`.
   */
  app.post('/servers/:id/services', { preHandler: gate('manage') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    const body = createBody.parse(req.body);
    const template = serviceTemplate(body.template);
    if (!template) return reply.status(400).send({ error: `No service template ${body.template}` });
    const version = body.version ? serviceVersion(template, body.version) : defaultServiceVersion(template);
    if (!version) return reply.status(400).send({ error: `${template.name} is offered in ${template.versions.map((v) => v.major).join(', ')}` });
    const memory = body.memory ?? template.memory;
    if (bytesOf(memory) < bytesOf(template.minMemory)) return reply.status(400).send({ error: `${template.name} needs at least ${template.minMemory} of memory` });
    if (bytesOf(memory) > 256 * 1024) return reply.status(400).send({ error: 'At most 256g of memory' });
    const publish = body.publish ?? { scope: 'none' as const };
    if (publish.scope !== 'none' && publish.port === undefined) return reply.status(400).send({ error: 'Publishing needs a host port (1024 to 65535)' });
    const domain = body.domain ?? null;
    if (domain && !template.ui?.domain) return reply.status(400).send({ error: `${template.name} has no web UI to give a domain` });

    return sseRoute(req, reply, id, async (ctx, open) => {
      const existing = await ctx.run<DeployAppStatus | { error: string }>(['status', body.name], { allowFailure: true });
      if (!('error' in existing.value)) throw new DeployError(`An app named ${body.name} exists on this server already`, 409, 'exists');
      const proxy = (await existingProxyMode(ctx.remote, ctx.root)) ?? 'caddy';
      const tls = body.tls ?? 'auto';
      if (domain && proxy === 'nginx' && tls === 'internal') throw new DeployError('In nginx mode certificates come from certbot: use tls auto or staging', 400);
      const text = serviceConfigYaml(template, {
        name: body.name,
        version,
        memory,
        publish: { scope: publish.scope, port: publish.scope === 'none' ? null : (publish.port ?? null) },
        domain,
        tls,
        proxy,
      });
      const file = `${ctx.root}/tmp/service-${body.name}-${Date.now().toString(36)}.yml`;
      await ctx.remote.writeFile(file, text, 0o600);
      try {
        const { value: validation } = await ctx.run<DeployValidation>(['validate', body.name, '--file', file], { allowFailure: true });
        if (!validation.ok) throw new DeployError('The service config is not valid', 422, 'invalid_config', { errors: validation.errors ?? [] });
        await ctx.run(['init', body.name, '--config', file]);
      } finally {
        await ctx.remote.remove(file);
      }
      // Fixed values over stdin (never a command line); secrets made on the server, never sent here
      for (const [key, value] of Object.entries(serviceFixedEnv(template, domain))) await ctx.run(['env', 'set', body.name, key], { stdin: value });
      const generated: string[] = [];
      for (const secret of template.secrets) {
        const { value } = await ctx.run<DeployEnvGenerated>(['env', 'generate', body.name, secret.key, '--bytes', String(secret.bytes), '--if-missing']);
        if (value.generated) generated.push(secret.key);
      }
      await auditService(req, 'deploy.service_create', ctx, {
        app: body.name,
        template: template.id,
        version: version.major,
        image: version.image,
        memory,
        publish: publish.scope === 'none' ? 'none' : `${publish.scope}:${publish.port}`,
        domain,
        generated,
      });
      const sse = open();
      if (!sse) return;
      say(
        sse,
        `Created ${body.name} from the ${template.name} template: ${version.image}`,
        ...template.secrets.map((s) => (generated.includes(s.key) ? `Generated ${s.key} on the server (${s.bytes} random bytes)` : `${s.key} is set already; kept`)),
      );
      await deployStreamed(req, ctx, sse, body.name, version.image);
    });
  });

  /**
   * GET /servers/:id/apps/:app/connection — how apps reach a quick
   * service: its name on bastion-apps, ports, the published address, and
   * connection strings with secrets as `{KEY}` placeholders. The browser
   * fills them in with the env reveal (manage, passkey step-up, audited).
   */
  app.get('/servers/:id/apps/:app/connection', { preHandler: gate('view') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    try {
      return await withDeploy(req, id, async (ctx): Promise<DeployServiceConnection> => {
        const { status, template } = await serviceOf(ctx, name);
        const config = status.config!;
        const pub = config.run.publish;
        const published =
          pub.scope === 'none' || pub.port === null
            ? null
            : { scope: pub.scope, host: pub.scope === 'localhost' ? '127.0.0.1' : ctx.server.host, port: pub.port, target: pub.target ?? config.run.port };
        const details = serviceConnectionDetails(template, { host: name, published });
        return {
          app: name,
          service: template.id,
          name: template.name,
          host: name,
          port: template.publishPort,
          ports: template.ports,
          published,
          ...details,
          ui: template.ui && config.domains.length > 0 ? { label: template.ui.label, urls: config.domains.map((d) => `https://${d}`) } : null,
          docs: `/docs/deployments/${template.docs}`,
        };
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /**
   * POST /servers/:id/apps/:app/service/version — `{ version }`: Update
   * version. Within a line (a newer pinned release of PostgreSQL 17) the
   * image is rewritten in bastion.yml and the service redeployed (recreate:
   * stopped, then started on the same data); a move across lines is refused
   * with the reason (409 `major_upgrade_refused`) unless the template
   * carries its data over. A deploy that fails puts the previous image back
   * in bastion.yml (the previous container is serving again). SSE like a
   * deploy; audited as `deploy.service_update`.
   */
  app.post('/servers/:id/apps/:app/service/version', { preHandler: gate('manage') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    const { version: major } = versionBody.parse(req.body);
    return sseRoute(req, reply, id, async (ctx, open) => {
      const { status, template } = await serviceOf(ctx, name);
      const config = status.config!;
      if (config.build.type !== 'image' || !config.build.image) throw new DeployError(`${name} is not built from an image`, 409, 'not_an_image');
      const target = serviceVersion(template, major);
      if (!target) throw new DeployError(`${template.name} is offered in ${template.versions.map((v) => v.major).join(', ')}`, 400);
      const from = serviceVersionOfImage(template, config.build.image);
      const allowed = serviceUpgradeAllowed(template, from, target);
      if (!allowed.ok) throw new DeployError(allowed.reason, 409, 'major_upgrade_refused', { docs: `/docs/deployments/${template.docs}#upgrading` });
      if (config.build.image === target.image) throw new DeployError(`${name} runs ${target.image} already`, 409, 'up_to_date');
      const previous = config.build.image;
      await ctx.run(['set-image', name, target.image], { timeoutMs: EDIT_TIMEOUT_MS });
      await auditService(req, 'deploy.service_update', ctx, { app: name, template: template.id, line: target.major, from: previous, to: target.image });
      const sse = open();
      if (!sse) return;
      say(sse, `Updating ${name} from ${previous} to ${target.image}`);
      const { outcome } = await deployStreamed(req, ctx, sse, name, target.image);
      if (outcome?.result !== 'success') {
        // The previous container serves again (recreate restarts it): bastion.yml says so too
        await ctx
          .run(['set-image', name, previous], { timeoutMs: EDIT_TIMEOUT_MS })
          .then(() => say(sse, `bastion.yml names ${previous} again`))
          .catch((err: Error) => say(sse, `warning: bastion.yml still names ${target.image}: ${err.message}`));
      }
    });
  });

  // ── Backups (services spec §3.4) ─────────────────────────────────────────

  /** GET /servers/:id/apps/:app/backups — newest first, with the schedule and its last run. */
  app.get('/servers/:id/apps/:app/backups', { preHandler: gate('view') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    try {
      return await withDeploy(req, id, async (ctx) => (await ctx.run<DeployBackupList>(['backups', 'list', name])).value);
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /** POST /servers/:id/apps/:app/backups — back up now (the dump runs in the service; the file stays on the server). */
  app.post('/servers/:id/apps/:app/backups', { preHandler: gate('operate') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    try {
      return await withDeploy(req, id, async (ctx) => {
        try {
          const { value } = await ctx.run<DeployBackupResult>(['backup', name], { timeoutMs: BACKUP_TIMEOUT_MS });
          await auditService(req, 'deploy.backup_create', ctx, { app: name, file: value.backup.file, bytes: value.backup.bytes, pruned: value.pruned, result: 'success' });
          return value;
        } catch (err) {
          await auditService(req, 'deploy.backup_create', ctx, { app: name, result: 'failed', error: auditError((err as Error).message) });
          throw err;
        }
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /**
   * GET /servers/:id/apps/:app/backups/:file — the file, streamed from the
   * server over SFTP (never stored here). A database's contents: manage, from
   * a browser session after a passkey step-up, audited.
   */
  app.get('/servers/:id/apps/:app/backups/:file', { preHandler: gate('manage') }, async (req, reply) => {
    const { id, app: name, file } = fileParams.parse(req.params);
    if (!requireStepUp(req, reply, 'Downloading a backup')) return reply;
    try {
      await withDeploy(req, id, async (ctx) => {
        const found = await ctx.remote.download(`${ctx.root}/apps/${name}/backups/${file}`);
        if (!found) throw new DeployError(`${name} has no backup ${file}`, 404);
        await auditService(req, 'deploy.backup_download', ctx, { app: name, file, bytes: found.size });
        reply
          .header('Content-Type', 'application/octet-stream')
          .header('Content-Length', String(found.size))
          .header('Content-Disposition', `attachment; filename="${name}-${file}"`)
          .header('Cache-Control', 'no-store');
        // The SFTP channel is ours until the last byte is sent
        const done = finished(found.stream).catch(() => {});
        reply.send(found.stream);
        await done;
      });
      return reply;
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /**
   * POST /servers/:id/apps/:app/backups/:file/restore — `{ confirm: <app> }`:
   * restore a backup into the running service. bastionctl backs up the data
   * it replaces first. Apps using the service keep running (see the docs).
   */
  app.post('/servers/:id/apps/:app/backups/:file/restore', { preHandler: gate('manage') }, async (req, reply) => {
    const { id, app: name, file } = fileParams.parse(req.params);
    const { confirm } = restoreBody.parse(req.body ?? {});
    if (confirm !== name) return reply.status(400).send({ error: `Type the service's name (${name}) to confirm the restore`, code: 'confirm_mismatch' });
    try {
      return await withDeploy(req, id, async (ctx) => {
        try {
          const { value } = await ctx.run<DeployRestoreResult>(['restore', name, file], { timeoutMs: BACKUP_TIMEOUT_MS });
          await auditService(req, 'deploy.backup_restore', ctx, { app: name, file, safety: value.safety?.file ?? null, method: value.method, result: 'success' });
          return value;
        } catch (err) {
          await auditService(req, 'deploy.backup_restore', ctx, { app: name, file, result: 'failed', error: auditError((err as Error).message) });
          throw err;
        }
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /** DELETE /servers/:id/apps/:app/backups/:file */
  app.delete('/servers/:id/apps/:app/backups/:file', { preHandler: gate('manage') }, async (req, reply) => {
    const { id, app: name, file } = fileParams.parse(req.params);
    try {
      return await withDeploy(req, id, async (ctx) => {
        const { value } = await ctx.run<{ app: string; file: string }>(['backups', 'delete', name, file]);
        await auditService(req, 'deploy.backup_delete', ctx, { app: name, file });
        return value;
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /** PUT /servers/:id/apps/:app/backups/schedule — `{ schedule: off|hourly|daily, keep? }`, written to bastion.yml; bastion-cron follows. */
  app.put('/servers/:id/apps/:app/backups/schedule', { preHandler: gate('manage') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    const { schedule, keep } = scheduleBody.parse(req.body);
    try {
      return await withDeploy(req, id, async (ctx) => {
        const args = ['backups', 'schedule', name, schedule, ...(keep !== undefined ? ['--keep', String(keep)] : [])];
        const { value } = await ctx.run<{ app: string; settings: { schedule: string; keep: number } }>(args, { timeoutMs: EDIT_TIMEOUT_MS });
        await auditService(req, 'deploy.backup_schedule', ctx, { app: name, ...value.settings });
        return value;
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });
}
