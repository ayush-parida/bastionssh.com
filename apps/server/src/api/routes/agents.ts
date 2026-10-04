import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, count, desc, eq, isNotNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Agent, CreatedAgent } from '@smt/shared';
import { AGENT_PORTS_HEADER, AGENT_VERSION_HEADER, AgentCloseCode, parsePortList } from '@smt/agent';
import { requireAuth } from '../../auth/middleware.js';
import { requireModule } from '../../auth/access/modules.js';
import { requireStepUpIfPasskeys } from '../../auth/passkey.js';
import { getDb } from '../../db/index.js';
import { agents, servers } from '../../db/schema.js';
import { audit } from '../../audit/index.js';
import { config } from '../../config/index.js';
import logger from '../../logger.js';
import { generateAgentToken, hashAgentToken, isAgentToken } from '../../agents/token.js';
import { acceptAgentConnection, disconnectAgent, liveAgentInfo, type AcceptedAgent } from '../../agents/hub.js';
import { agentBundle, installCommand, installScript } from '../../agents/install.js';

type AgentRow = typeof agents.$inferSelect;

const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  allowedPorts: z.array(z.number().int().min(1).max(65535)).min(1).max(16).optional(),
});

export function agentView(row: AgentRow, serverCount: number): Agent {
  const connection = row.revokedAt ? null : liveAgentInfo(row.id);
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    status: row.revokedAt ? 'revoked' : connection ? 'online' : 'offline',
    lastSeenAt: row.lastSeenAt,
    version: row.version,
    connection,
    serverCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

function serverCounts(orgId: string): Map<string, number> {
  const rows = getDb()
    .select({ agentId: servers.agentId, n: count() })
    .from(servers)
    .where(and(eq(servers.orgId, orgId), isNotNull(servers.agentId)))
    .groupBy(servers.agentId)
    .all();
  return new Map(rows.map((r) => [r.agentId!, r.n]));
}

/**
 * Connectivity agents (unified roles spec §3.2): list with live status at
 * `view`; create (the token and install command are shown once) and revoke
 * at `manage`.
 */
export async function agentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireModule('agents', 'view'));

  app.get('/', async (req) => {
    const counts = serverCounts(req.orgId);
    return getDb()
      .select()
      .from(agents)
      .where(eq(agents.orgId, req.orgId))
      .orderBy(desc(agents.createdAt))
      .all()
      .map((row) => agentView(row, counts.get(row.id) ?? 0));
  });

  app.post('/', { preHandler: requireModule('agents', 'manage'), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = createAgentSchema.parse(req.body);
    // An agent token is a standing credential into the org's network: as with
    // other credentials, a passkey holder must have used it for this session.
    if (!requireStepUpIfPasskeys(req, reply, req.orgId)) return reply;

    const id = nanoid();
    const { token, tokenHash } = generateAgentToken();
    getDb()
      .insert(agents)
      .values({ id, orgId: req.orgId, name: body.name, tokenHash, createdBy: req.user.id })
      .run();
    await audit(req, 'agent.create', 'agent', id, body.name, {
      ...(body.allowedPorts && { allowedPorts: body.allowedPorts }),
    });

    const row = getDb().select().from(agents).where(eq(agents.id, id)).get()!;
    const created: CreatedAgent = {
      ...agentView(row, 0),
      token,
      installCommand: installCommand(config.baseUrl, token, body.allowedPorts),
    };
    return reply.status(201).send(created);
  });

  /** Revoke for good: the token stops working and a live connection is dropped. */
  app.post('/:id/revoke', { preHandler: requireModule('agents', 'manage') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const row = db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.orgId, req.orgId)))
      .get();
    if (!row) return reply.status(404).send({ error: 'Not found' });

    if (!row.revokedAt) {
      db.update(agents).set({ revokedAt: new Date().toISOString() }).where(eq(agents.id, id)).run();
      // Servers keep pointing at the agent, so they fail closed rather than
      // quietly falling back to a direct connection.
      const wasOnline = disconnectAgent(id);
      await audit(req, 'agent.revoke', 'agent', id, row.name, {
        wasOnline,
        serverCount: serverCounts(req.orgId).get(id) ?? 0,
      });
    }
    const updated = db.select().from(agents).where(eq(agents.id, id)).get()!;
    return agentView(updated, serverCounts(req.orgId).get(id) ?? 0);
  });
}

// ── Agent-facing endpoints ─────────────────────────────────────────────────────

/** The authenticated agent for a connect request, set by {@link authenticateAgent}. */
const acceptedAgents = new WeakMap<FastifyRequest, AcceptedAgent>();

const MAX_VERSION_LENGTH = 32;

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

async function authenticateAgent(req: FastifyRequest, reply: FastifyReply) {
  if (!req.ws) return reply.status(426).send({ error: 'Upgrade to a WebSocket' });

  const auth = headerValue(req, 'authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  // One answer for unknown, malformed and revoked tokens
  const row = isAgentToken(token)
    ? getDb().select().from(agents).where(eq(agents.tokenHash, hashAgentToken(token))).get()
    : undefined;
  if (!row || row.revokedAt) {
    logger.warn(
      { ip: req.ip, agentId: row?.id, revoked: !!row?.revokedAt },
      'Agent connection refused: invalid or revoked token',
    );
    return reply.status(401).send({ error: 'Invalid or revoked agent token' });
  }

  const rawVersion = headerValue(req, AGENT_VERSION_HEADER)?.trim();
  const version =
    rawVersion && rawVersion.length <= MAX_VERSION_LENGTH && /^[\w.+-]+$/.test(rawVersion) ? rawVersion : null;
  // Informational only (the agent enforces its own allowlist): unparseable means unknown
  let allowedPorts: number[] = [];
  try {
    allowedPorts = parsePortList(headerValue(req, AGENT_PORTS_HEADER) ?? '').slice(0, 64);
  } catch {
    allowedPorts = [];
  }

  acceptedAgents.set(req, { row, remoteAddress: req.ip, version, allowedPorts });
}

/**
 * Unauthenticated as far as users go: the agent's WebSocket (authenticated by
 * its own token) and the files the install command downloads.
 */
export async function agentConnectRoutes(app: FastifyInstance) {
  /** GET /api/agents/connect — the agent's WebSocket, `Authorization: Bearer bsa_…` */
  app.get(
    '/connect',
    {
      websocket: true,
      // Per IP: an agent reconnects with backoff, so this only bites guessing
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: authenticateAgent,
    },
    (socket, req) => {
      const agent = acceptedAgents.get(req);
      if (!agent) {
        socket.close(1008, 'Unauthorized');
        return;
      }
      acceptedAgents.delete(req);
      // A revocation that landed while the upgrade was in flight still wins
      const current = getDb().select().from(agents).where(eq(agents.id, agent.row.id)).get();
      if (!current || current.revokedAt) {
        socket.close(AgentCloseCode.REVOKED, 'Agent revoked');
        return;
      }
      acceptAgentConnection(socket, { ...agent, row: current });
    },
  );

  /** GET /api/agents/install.sh — the install script (no secrets in it) */
  app.get('/install.sh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (_req, reply) => {
    const bundle = agentBundle();
    if (!bundle) return reply.status(503).send({ error: 'The agent has not been built on this server' });
    return reply
      .type('text/x-shellscript; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(installScript(config.baseUrl, bundle.sha256));
  });

  /** GET /api/agents/bastion-agent.cjs — the single-file agent */
  app.get('/bastion-agent.cjs', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (_req, reply) => {
    const bundle = agentBundle();
    if (!bundle) return reply.status(503).send({ error: 'The agent has not been built on this server' });
    return reply
      .type('application/javascript; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('x-content-sha256', bundle.sha256)
      .send(bundle.code);
  });
}
