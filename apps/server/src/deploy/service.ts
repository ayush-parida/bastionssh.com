import type { FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { canAccessServer } from '../auth/server-access.js';
import { getDb } from '../db/index.js';
import { servers } from '../db/schema.js';
import { DockerError } from '../docker/errors.js';
import { CredentialError } from '../ssh/credentials.js';
import { JumpHostError } from '../ssh/jump.js';
import { DeployError } from './errors.js';
import { discoverRoot, requireBundle } from './install.js';
import { openRemote, type Remote, type RunOptions, type ServerRow } from './remote.js';
import { actorLabel, bastionctl, type BastionctlRun } from './runner.js';
import { ensureCurrent, requireCurrent, upgradeAudit, type BastionctlUpgrade, type UpgradeCaller } from './upgrade.js';

/**
 * The one way a deployments route reaches a server, like `withDockerClient`:
 *
 * 1. 404 for a server the caller cannot access or that is not in their org
 *    (the route's preHandlers already weighed module and level);
 * 2. the caller's pooled connections (deploy/remote.ts);
 * 3. the root directory, discovered now (409 `not_set_up` without one);
 * 4. bastionctl's integrity — installed files that are not exactly the ones
 *    this BastionSSH ships are upgraded to them first (deploy/upgrade.ts,
 *    audited under the caller); 409 `bastionctl_mismatch` when the server is
 *    pinned or the upgrade fails;
 * 5. everything released when the callback settles.
 *
 * Nothing about apps is kept between requests (spec §7).
 */

export interface DeployContext {
  server: ServerRow;
  remote: Remote;
  root: string;
  /** `bastionctl <args> --json`, as the caller. */
  run<T>(args: string[], opts?: RunOptions & { allowFailure?: boolean }): Promise<BastionctlRun<T>>;
  /** Set when this request upgraded the server's bastionctl before running. */
  upgraded?: BastionctlUpgrade;
}

/** Who asks; with the request's address and user agent when there is one (for the audit). */
type Caller = UpgradeCaller;

export function deployServer(req: Caller, serverId: string): ServerRow {
  if (!canAccessServer(req, serverId)) throw new DeployError('Server not found', 404);
  const row = getDb()
    .select()
    .from(servers)
    .where(and(eq(servers.id, serverId), eq(servers.orgId, req.orgId)))
    .get();
  if (!row) throw new DeployError('Server not found', 404);
  return row;
}

/** Run `fn` with the caller's connections to the server, set up or not (setup, state). */
export async function withRemote<T>(req: Caller, serverId: string, fn: (remote: Remote) => Promise<T>): Promise<T> {
  const server = deployServer(req, serverId);
  const remote = await openRemote(req, server);
  try {
    return await fn(remote);
  } finally {
    remote.release();
  }
}

export function contextFor(req: Caller, remote: Remote, root: string): DeployContext {
  const actor = actorLabel(req.user);
  return {
    server: remote.server,
    remote,
    root,
    run: (args, opts) => bastionctl(remote, root, args, { actor, ...opts }),
  };
}

/** Run `fn` against a set-up server whose bastionctl checks out (see the module comment). */
export async function withDeploy<T>(req: Caller, serverId: string, fn: (ctx: DeployContext) => Promise<T>): Promise<T> {
  const bundle = requireBundle();
  return withRemote(req, serverId, async (remote) => {
    const root = await discoverRoot(remote);
    if (!root) throw new DeployError('Deployments are not set up on this server', 409, 'not_set_up');
    const installed = await ensureCurrent(remote, root, bundle, upgradeAudit(req, remote.server, 'request'));
    requireCurrent(installed, root, bundle);
    return fn({ ...contextFor(req, remote, root), ...(installed.upgraded && { upgraded: installed.upgraded }) });
  });
}

/**
 * Answer a deployments, credential, connection or jump host failure with its
 * own status. Anything else is rethrown for the app's error handler (a host
 * key mismatch becomes its 409 there).
 */
export function sendDeployError(reply: FastifyReply, err: unknown) {
  if (err instanceof DeployError) return reply.status(err.statusCode).send(err.toJSON());
  if (err instanceof DockerError) return reply.status(err.statusCode).send({ error: err.message });
  if (err instanceof CredentialError) return reply.status(err.statusCode).send({ error: err.message });
  if (err instanceof JumpHostError) return reply.status(err.statusCode).send({ error: err.message });
  throw err;
}
