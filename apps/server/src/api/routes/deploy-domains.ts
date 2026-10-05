import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEPLOY_NAME_PATTERN, type DeployAppStatus, type DeployCertFacts, type DeployDomainsReport, type DeployNginxApplyResult, type DeployProxyState } from '@smt/shared';
import { audit } from '../../audit/index.js';
import { requireBundle, discoverRoot } from '../../deploy/install.js';
import { reconcileAppCertificates } from '../../deploy/cert-alerts.js';
import { domainsReport, type DomainDeps } from '../../deploy/domains.js';
import { DeployError } from '../../deploy/errors.js';
import { nginxCertificates, proxyState, readProxyMode, runHelper } from '../../deploy/nginx.js';
import { sendDeployError, withDeploy, withRemote, type DeployContext } from '../../deploy/service.js';

/**
 * Domains, TLS and the proxy (deployments spec §6), under
 * `/api/deploy/servers/:id` beside the other deployment routes (and behind
 * the same auth and Deployments module hook):
 *
 * - `GET /proxy` (view): the proxy mode, the host's nginx as detected, and
 *   for nginx mode the one-time commands an administrator still has to run;
 * - `GET /apps/:app/domains` (view): DNS against the server's public address
 *   with the exact records to create, ports 80/443 for ACME certificates, and
 *   each certificate's issuer, expiry, last error and state — reading it is
 *   also what raises (and clears) renewal alerts;
 * - `POST /apps/:app/proxy` (operate): run the nginx helper for the app again
 *   (after fixing DNS, to retry its certificate).
 *
 * Everything is read from the server and the network on each request; the
 * only rows written are audit entries and certificate alerts (monitoring
 * data in `server_alerts`, deploy/cert-alerts.ts).
 */

/** deploy.ts's module + server level check. */
type Gate = (level: 'view' | 'operate' | 'manage') => Array<(req: FastifyRequest, reply: FastifyReply) => Promise<unknown>>;

const serverParams = z.object({ id: z.string().min(1) });
const appParams = serverParams.extend({ app: z.string().regex(DEPLOY_NAME_PATTERN, 'Invalid app name') });

/** Tests swap DNS and TCP for fakes. */
let domainDeps: DomainDeps | undefined;
export function setDomainDepsForTests(deps: DomainDeps | undefined): void {
  domainDeps = deps;
}

/**
 * Bring the host's nginx in line with an app after its proxy entry changed
 * (deploy, config change, delete) — in nginx mode only, and for `apply` only
 * once bastionctl wrote the app's site file (it has been deployed). Progress
 * lines go to `onLine` (the deploy log). Audited; failures are returned, not
 * thrown: what came before already happened.
 */
export async function syncProxy(
  req: FastifyRequest,
  ctx: Pick<DeployContext, 'server' | 'remote' | 'root'>,
  app: string,
  action: 'apply' | 'remove',
  onLine?: (line: string) => void,
): Promise<DeployNginxApplyResult | null> {
  let result: DeployNginxApplyResult;
  try {
    if ((await readProxyMode(ctx.remote, ctx.root)) !== 'nginx') return null;
    if (action === 'apply' && (await ctx.remote.readFile(`${ctx.root}/proxy/nginx/${app}.site`, 16 * 1024)) === null) return null;
    result = await runHelper(ctx.remote, ctx.root, app, action, requireBundle(), onLine);
  } catch (err) {
    // Any failure (SFTP or SSH included): the deploy, config change or delete already happened
    const message = (err as Error).message || 'The nginx helper could not be run';
    result = { app, result: 'failed', certificate: 'skipped', error: message.slice(0, 500), log: [] };
    onLine?.(`nginx: ${message}`);
  }
  await audit(req, 'deploy.proxy_sync', 'server', ctx.server.id, ctx.server.name, {
    app,
    action,
    result: result.result,
    certificate: result.certificate,
    error: result.error?.split('\n')[0]?.slice(0, 300) ?? null,
  });
  return result;
}

export async function deployDomainRoutes(app: FastifyInstance, opts: { gate: Gate }) {
  const { gate } = opts;

  /** GET /servers/:id/proxy — mode, host nginx, and what nginx mode still needs. */
  app.get('/servers/:id/proxy', { preHandler: gate('view') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    try {
      const bundle = requireBundle();
      return await withRemote(req, id, async (remote): Promise<DeployProxyState> => proxyState(remote, await discoverRoot(remote), bundle));
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /** GET /servers/:id/apps/:app/domains — DNS, ports and certificates, checked now. */
  app.get('/servers/:id/apps/:app/domains', { preHandler: gate('view') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    try {
      return await withDeploy(req, id, async (ctx): Promise<DeployDomainsReport> => {
        const { value: status } = await ctx.run<DeployAppStatus>(['status', name]);
        if (!status.config) throw new DeployError(status.configError ?? `bastion.yml of ${name} is invalid`, 422, 'invalid_config');
        const config = status.config;
        const proxy = (await readProxyMode(ctx.remote, ctx.root)) ?? 'caddy';
        const report = await domainsReport({
          app: name,
          config,
          proxy,
          server: ctx.server,
          remote: ctx.remote,
          certificates: async () =>
            proxy === 'nginx'
              ? nginxCertificates(ctx.remote, name, config.tls === 'staging', config.domains, requireBundle())
              : (await ctx.run<DeployCertFacts[]>(['certs', name])).value,
          deps: domainDeps,
        });
        // Certificates read (not merely unreadable): bring the app's alerts in line
        if (!report.certificatesError) {
          reconcileAppCertificates(req.orgId, ctx.server.id, name, report.domains.flatMap((d) => (d.certificate ? [d.certificate] : [])), config.domains);
        }
        return report;
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /** POST /servers/:id/apps/:app/proxy — run the nginx helper for the app again (nginx mode). */
  app.post('/servers/:id/apps/:app/proxy', { preHandler: gate('operate') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    try {
      return await withDeploy(req, id, async (ctx) => {
        if ((await readProxyMode(ctx.remote, ctx.root)) !== 'nginx') throw new DeployError('This server’s proxy is Caddy: certificates and the proxy config are managed on every deploy', 409);
        const result = await syncProxy(req, ctx, name, 'apply');
        if (!result) throw new DeployError(`${name} has not been deployed yet: there is no server block to write`, 409);
        return result;
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });
}
