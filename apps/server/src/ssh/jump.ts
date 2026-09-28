import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig } from 'ssh2';
import { and, eq } from 'drizzle-orm';
import type { HostKeyScanResult } from '@smt/shared';
import { getDb } from '../db/index.js';
import { servers } from '../db/schema.js';
import { auditUser } from '../audit/index.js';
import { canAccessServer } from '../auth/server-access.js';
import logger from '../logger.js';
import { resolveServerAuth } from './credentials.js';
import {
  HostKeyMismatchError,
  SCAN_TIMEOUT_MS,
  agentSocketFor,
  scanHostKey,
  sshConnectConfig,
  type HostKeyPurpose,
  type SshTarget,
} from './host-keys.js';

/**
 * Jump hosts (bastions), like `ssh -J`. A server may name another managed
 * server in the same org as its jump host; connections to it then:
 *
 * 1. connect to the jump host with the jump host's own credentials, its host
 *    key verified against its own pinned key ({@link sshConnectConfig});
 * 2. open a `direct-tcpip` channel (forwardOut) from there to the target's
 *    host:port;
 * 3. run the target's SSH handshake over that channel (`sock`), its host key
 *    verified against the target's pinned key as for any direct connection.
 *
 * Jump hosts may themselves have jump hosts, up to {@link MAX_JUMP_DEPTH} hops,
 * and the chain may never loop. Every hop is audited as `server.jump` against
 * the jump server (except unattended background health checks, which only
 * log), and the jump connections are closed with the target's.
 *
 * Access: using a server through its jump host does NOT require the user to
 * have access to the jump server. The jump host is part of how an admin wired
 * the target up — like its credentials, which members also use without seeing
 * — and the user only ever gets a channel to the target, never a shell or
 * files on the jump host. Only admins can set or change a jump host. The hop
 * is audited so it remains visible who went through which bastion.
 *
 * Errors: a failure at a hop (unreachable, refused login, changed host key)
 * names the jump host. Only someone who may access that jump server (admins,
 * or members granted it) gets those details back; anyone else — and
 * background work with no user, whose errors are stored where members read
 * them — gets "The route to this server failed at hop N" instead, hops counted
 * from this app outwards. The full error is always logged.
 */

/** Most jump hosts between us and a server. */
export const MAX_JUMP_DEPTH = 3;

/** How long one hop may take to connect and open its forwarding channel. */
const HOP_TIMEOUT_MS = 20_000;

export class JumpHostError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
    /** For a failure at a hop: which one, counted from this app (1 = the host we connect to first). */
    readonly hop?: number,
  ) {
    super(message);
    this.name = 'JumpHostError';
  }
}

/**
 * The error to hand back for a failure at `hop` (the `hopNumber`-th from this
 * app): as-is for someone who may access the jump server, otherwise a generic
 * one that does not name it. The original is logged either way.
 */
function hopFailure(err: unknown, hop: ServerRow, hopNumber: number, target: SshTarget, options: JumpOptions): unknown {
  const reveal = options.actorUserId
    ? canAccessServer({ orgId: hop.orgId, userId: options.actorUserId }, hop.id)
    : false;
  logger.warn(
    { err, jumpServerId: hop.id, targetId: target.id, hop: hopNumber, actorUserId: options.actorUserId },
    'Jump host hop failed',
  );
  if (reveal) return err;
  return new JumpHostError(`The route to this server failed at hop ${hopNumber}`, 502, hopNumber);
}

type ServerRow = typeof servers.$inferSelect;

function loadServer(orgId: string | undefined, id: string): ServerRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(servers)
    .where(orgId ? and(eq(servers.id, id), eq(servers.orgId, orgId)) : eq(servers.id, id))
    .get();
}

/**
 * The jump servers in front of `serverId`, nearest to the target first (so the
 * last one is the host we connect to directly). Empty for a direct server or
 * one that does not exist. Throws on a loop, a chain longer than
 * {@link MAX_JUMP_DEPTH}, or a jump host that is missing or in another org —
 * the API refuses all of those, so reaching one here means the data is broken
 * and connecting anyway could send credentials somewhere unintended.
 */
export function jumpChain(serverId: string): ServerRow[] {
  const target = loadServer(undefined, serverId);
  if (!target) return [];

  const chain: ServerRow[] = [];
  const seen = new Set([target.id]);
  let next = target.jumpServerId;
  while (next) {
    if (seen.has(next)) throw new JumpHostError(`Jump host chain for ${target.name} loops`, 400);
    if (chain.length >= MAX_JUMP_DEPTH) {
      throw new JumpHostError(
        `Jump host chain for ${target.name} is longer than ${MAX_JUMP_DEPTH} hops`,
        400,
      );
    }
    const hop = loadServer(target.orgId, next);
    if (!hop) throw new JumpHostError(`Jump host for ${target.name} no longer exists`, 400);
    seen.add(hop.id);
    chain.push(hop);
    next = hop.jumpServerId;
  }
  return chain;
}

/**
 * Why `jumpServerId` cannot be the jump host of `serverId` (undefined for a
 * server being created), or null when it can. Checks the same org, no loop,
 * and that neither this server nor any server already behind it ends up more
 * than {@link MAX_JUMP_DEPTH} hops away.
 */
export function jumpHostProblem(
  orgId: string,
  serverId: string | undefined,
  jumpServerId: string,
): string | null {
  if (serverId && jumpServerId === serverId) return 'A server cannot be its own jump host';
  const jump = loadServer(orgId, jumpServerId);
  if (!jump) return 'Unknown jump host';

  // Hops from the jump host onwards: the jump host itself plus its own chain
  let above: number;
  try {
    const chain = jumpChain(jump.id);
    if (serverId && chain.some((hop) => hop.id === serverId)) {
      return `${jump.name} already connects through this server — that would be a loop`;
    }
    above = 1 + chain.length;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid jump host';
  }

  const below = serverId ? depthBehind(orgId, serverId) : 0;
  if (above + below > MAX_JUMP_DEPTH) {
    return `Jump host chains are limited to ${MAX_JUMP_DEPTH} hops`;
  }
  return null;
}

/** Servers in the org that jump through `serverId`, directly or further down, with their distance. */
function behind(orgId: string, serverId: string): Map<string, number> {
  const rows = getDb()
    .select({ id: servers.id, jumpServerId: servers.jumpServerId })
    .from(servers)
    .where(eq(servers.orgId, orgId))
    .all();
  const found = new Map<string, number>();
  let frontier = [serverId];
  // Bounded: stored chains are at most MAX_JUMP_DEPTH long, and `found`
  // stops a broken loop from spinning.
  for (let distance = 1; frontier.length > 0 && distance <= rows.length; distance++) {
    const next: string[] = [];
    for (const row of rows) {
      if (row.jumpServerId && frontier.includes(row.jumpServerId) && !found.has(row.id) && row.id !== serverId) {
        found.set(row.id, distance);
        next.push(row.id);
      }
    }
    frontier = next;
  }
  return found;
}

function depthBehind(orgId: string, serverId: string): number {
  let max = 0;
  for (const distance of behind(orgId, serverId).values()) max = Math.max(max, distance);
  return max;
}

/** Ids of every server that connects through `serverId` — their pooled connections go stale with it. */
export function serversBehind(orgId: string, serverId: string): string[] {
  return [...behind(orgId, serverId).keys()];
}

// ── Tunnels ──────────────────────────────────────────────────────────────────

/** Who a connection is for — the jump hop is audited under them. */
export interface JumpOptions {
  /** The user the connection is opened for; system when absent (health checks). */
  actorUserId?: string;
}

export interface JumpTunnel {
  /** A channel to the target's host:port through the last hop; hand it to ssh2 as `sock`. */
  sock: ClientChannel;
  /** Close every jump connection. Safe to call more than once. */
  close: () => void;
}

function endQuietly(client: Client) {
  try {
    client.end();
  } catch {
    // already torn down
  }
}

/**
 * Connect one hop, optionally over the previous hop's channel. `track` gets the
 * client before it connects, so an abort can end a hop still handshaking.
 */
function connectHop(
  hop: ServerRow,
  auth: { privateKey?: string; password?: string },
  purpose: HostKeyPurpose,
  sock: ClientChannel | undefined,
  track: (client: Client) => void,
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    track(client);
    const { config, guard } = sshConnectConfig(
      { id: hop.id, host: hop.host, port: hop.port, username: hop.username },
      auth,
      purpose,
      { readyTimeout: HOP_TIMEOUT_MS, ...(sock && { sock }) },
    );
    let settled = false;
    client
      .on('ready', () => {
        settled = true;
        resolve(client);
      })
      .on('error', (err: Error) => {
        const cause = guard.error(err);
        if (settled) {
          logger.warn({ err: cause, jumpServerId: hop.id }, 'Jump host connection error');
          return;
        }
        settled = true;
        endQuietly(client);
        // A refused host key is reported as such, naming the jump host
        reject(
          cause instanceof HostKeyMismatchError
            ? cause
            : new JumpHostError(`Jump host ${hop.name} (${hop.host}:${hop.port}): ${cause.message}`),
        );
      })
      .on('close', () => {
        if (settled) return;
        settled = true;
        reject(new JumpHostError(`Jump host ${hop.name} (${hop.host}:${hop.port}) closed the connection`));
      })
      .connect(config);
  });
}

function forward(client: Client, hop: ServerRow, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new JumpHostError(`Jump host ${hop.name} did not open a channel to ${host}:${port} in time`));
    }, HOP_TIMEOUT_MS);
    client.forwardOut('127.0.0.1', 0, host, port, (err, channel) => {
      clearTimeout(timer);
      if (err) {
        reject(new JumpHostError(`Jump host ${hop.name} could not reach ${host}:${port}: ${err.message}`));
        return;
      }
      resolve(channel);
    });
  });
}

/**
 * Open the jump chain in front of `target` and return a channel to its
 * host:port, or null when the server is reached directly. Each hop is
 * host-key-verified and audited; on any failure every hop opened so far is
 * closed before the error is thrown.
 */
export async function openJumpTunnel(
  target: SshTarget,
  purpose: HostKeyPurpose,
  options: JumpOptions = {},
  /** Aborting ends every hop at once, including one still connecting. */
  signal?: AbortSignal,
): Promise<JumpTunnel | null> {
  const chain = jumpChain(target.id);
  if (chain.length === 0) return null;

  // Connect from the far end: the last jump host is the one we can reach
  const hops = [...chain].reverse();
  const clients: Client[] = [];
  const close = () => {
    for (const client of clients.splice(0).reverse()) endQuietly(client);
  };

  const checkAborted = () => {
    if (signal?.aborted) throw new JumpHostError(`Connection to ${target.host}:${target.port} was abandoned`);
  };
  signal?.addEventListener('abort', close, { once: true });

  let sock: ClientChannel | undefined;
  try {
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i]!;
      const next = i + 1 < hops.length ? hops[i + 1]! : target;
      const atHop = (err: unknown) => {
        throw hopFailure(err, hop, i + 1, target, options);
      };
      const { auth } = await resolveServerAuth(hop.orgId, hop.id).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        return atHop(new JumpHostError(`Jump host ${hop.name}: ${reason}`, 502, i + 1));
      });
      checkAborted();
      const client = await connectHop(hop, auth, purpose, sock, (c) => clients.push(c)).catch(atHop);
      checkAborted();
      sock = await forward(client, hop, next.host, next.port).catch(atHop);
      checkAborted();

      const detail = { targetId: target.id, to: `${next.host}:${next.port}`, hop: hops.length - i, via: purpose };
      if (purpose === 'health_check' && !options.actorUserId) {
        // Background sweeps run every minute for every server; auditing each
        // of their hops would bury the log. Nobody acts through them.
        logger.debug({ jumpServerId: hop.id, ...detail }, 'Health check through jump host');
      } else {
        auditUser(hop.orgId, options.actorUserId, 'server.jump', 'server', hop.id, hop.name, detail);
      }
    }
  } catch (err) {
    close();
    throw err;
  } finally {
    signal?.removeEventListener('abort', close);
  }

  // Any hop going away takes the tunnel (and so the target) with it
  for (const client of clients) client.once('close', close);
  return { sock: sock!, close };
}

/**
 * Connect `client` to `target` with `config` from {@link sshConnectConfig},
 * through the target's jump hosts when it has any. The central connect path:
 * callers attach their `'ready'` / `'error'` handlers first, then call this in
 * place of `client.connect(config)`. A failure to reach a jump host arrives on
 * the client's `'error'` event like any other connection error.
 *
 * The jump connections close when the target connection closes, and a
 * `client.end()` issued while the jump chain is still connecting (a caller's
 * timeout) aborts it.
 */
export function connectSsh(
  client: Client,
  target: SshTarget,
  config: ConnectConfig,
  purpose: HostKeyPurpose,
  options: JumpOptions = {},
): void {
  // Only configs built by sshConnectConfig carry the verifier; never connect without one
  if (typeof config.hostVerifier !== 'function') {
    throw new Error('SSH connections must be configured through sshConnectConfig');
  }

  let chain: ServerRow[];
  try {
    chain = jumpChain(target.id);
  } catch (err) {
    process.nextTick(() => client.emit('error', err));
    return;
  }
  if (chain.length === 0) {
    client.connect(config);
    return;
  }

  let aborted = false;
  let tunnel: JumpTunnel | null = null;
  const abort = new AbortController();
  const end = client.end.bind(client);
  client.end = () => {
    aborted = true;
    abort.abort();
    tunnel?.close();
    return end();
  };
  client.once('close', () => tunnel?.close());

  openJumpTunnel(target, purpose, options, abort.signal).then(
    (opened) => {
      if (aborted || !opened) {
        opened?.close();
        return;
      }
      tunnel = opened;
      // The target's own verifier stays in `config`: its key is checked end to end
      client.connect({ ...config, sock: opened.sock });
    },
    (err: unknown) => {
      if (!aborted) client.emit('error', err instanceof Error ? err : new Error(String(err)));
    },
  );
}

/**
 * {@link scanHostKey} for a managed server, reaching it through its jump hosts
 * when it has any — the key we want is the one the target presents, as seen
 * from the last hop — or else through its connectivity agent.
 */
export async function scanServerHostKey(
  target: SshTarget,
  options: JumpOptions = {},
): Promise<HostKeyScanResult> {
  const tunnel = await openJumpTunnel(target, 'host_key_scan', options);
  try {
    const sock = tunnel?.sock ?? agentSocketFor(loadServer(undefined, target.id), target.port);
    return await scanHostKey(target.host, target.port, SCAN_TIMEOUT_MS, null, sock);
  } finally {
    tunnel?.close();
  }
}
