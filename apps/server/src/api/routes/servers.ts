import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CloudProvider, CloudServerState, DockerMode, DockerTransport, Server } from '@smt/shared';
import { rank, requireAuth, requireRole } from '../../auth/middleware.js';
import { accessibleServerFilter, canAccessServer, requireServer } from '../../auth/server-access.js';
import { revokeAfterChange, snapshotAccess } from '../../auth/access/revoke.js';
import { activeAt } from '../../auth/access/resolve.js';
import { getDb } from '../../db/index.js';
import { agents, resourceGrants, roleMembers, roles, servers, sshKeys } from '../../db/schema.js';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { audit } from '../../audit/index.js';
import { vault } from '../../vault/index.js';
import { evictServer } from '../../ssh/sftp.js';
import { evictDockerServer } from '../../docker/index.js';
import { evictKubeServer } from '../../kube/index.js';
import { clearedDetection } from '../../docker/probe.js';
import { isValidSocketPath } from '../../docker/validation.js';
import { clearedColumns, hostKeyStatus, pinnedColumns } from '../../ssh/host-keys.js';
import { jumpHostProblem, serversBehind } from '../../ssh/jump.js';
import { resolveHostKeyAlert } from '../../monitoring/alerts.js';
import { fingerprintSchema } from './server-host-keys.js';

const createServerSchema = z.object({
  name: z.string().min(1).max(100),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  authType: z.enum(['key', 'password']).default('key'),
  defaultKeyId: z.string().optional(),
  password: z.string().optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  /** Pre-pin the host key; otherwise the first connection trusts what it sees. */
  hostKeyFingerprint: fingerprintSchema.optional(),
  /** Reach the server through another one in the org (ssh -J); null connects directly. */
  jumpServerId: z.string().min(1).nullable().optional(),
  /** Reach the server through this connectivity agent (to its loopback, on `port`); null = directly. */
  agentId: z.string().min(1).nullable().optional(),
  /** Docker for this server: 'off' hides it and refuses its routes. */
  dockerMode: z.enum(['auto', 'off']).optional(),
  /** Docker socket override (rootless Docker, Podman); null returns to detection. */
  dockerSocketPath: z
    .string()
    .trim()
    .refine(isValidSocketPath, 'must be an absolute path to a Unix socket')
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v)),
});

/** Strip encryptedPassword and return safe server object */
/** Tags are stored as a JSON string; the API contract is an array of strings. */
export function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Strip the secret, expand tags, and fold the cloud_* columns into one object. */
export function sanitize(row: typeof servers.$inferSelect): Server {
  const {
    encryptedPassword,
    cloudAccountId,
    cloudProvider,
    cloudInstanceId,
    cloudRegion,
    cloudState,
    cloudSyncedAt,
    hostKeyType,
    hostKeyTrustedAt,
    hostKeyTrustedBy,
    hostKeyMismatchFingerprint,
    hostKeyMismatchType,
    hostKeyMismatchAt,
    dockerMode,
    dockerSocketPath,
    dockerTransport,
    dockerDetectedSocketPath,
    dockerDetectedAt,
    dockerVersion,
    dockerApiVersion,
    ...safe
  } = row;
  return {
    ...safe,
    hostKeyStatus: hostKeyStatus(row),
    defaultKeyId: safe.defaultKeyId ?? undefined,
    notes: safe.notes ?? undefined,
    tags: parseTags(row.tags),
    authType: encryptedPassword ? 'password' : 'key',
    cloud:
      cloudInstanceId && cloudProvider
        ? {
            accountId: cloudAccountId,
            provider: cloudProvider as CloudProvider,
            instanceId: cloudInstanceId,
            region: cloudRegion,
            state: (cloudState ?? 'other') as CloudServerState,
            syncedAt: cloudSyncedAt,
          }
        : null,
    docker: {
      mode: dockerMode as DockerMode,
      socketPath: dockerSocketPath,
      transport: dockerTransport as DockerTransport | null,
      detectedSocketPath: dockerDetectedSocketPath,
      detectedAt: dockerDetectedAt,
      version: dockerVersion,
      apiVersion: dockerApiVersion,
    },
  };
}

/**
 * Drop pooled SFTP and Docker connections to a server and to every server
 * reached through it — theirs run over a tunnel built with this server's old
 * settings.
 */
function evictWithDependents(orgId: string, serverId: string) {
  for (const id of [serverId, ...serversBehind(orgId, serverId)]) {
    evictServer(orgId, id);
    evictDockerServer(orgId, id);
    evictKubeServer(orgId, id);
  }
}

/** A server may only point at a vaulted key from its own org that a rotation has not retired. */
function keyBelongsToOrg(orgId: string, keyId: string): boolean {
  return (
    getDb()
      .select({ id: sshKeys.id })
      .from(sshKeys)
      .where(and(eq(sshKeys.id, keyId), eq(sshKeys.orgId, orgId), isNull(sshKeys.retiredAt)))
      .get() !== undefined
  );
}

/** One route per server: its jump host or its agent carries the connection, not both. */
const ROUTE_CONFLICT = 'A server connects through a jump host or a connectivity agent, not both';

/** A server may only route through a live (unrevoked) agent of its own org. */
function agentUsableByOrg(orgId: string, agentId: string): boolean {
  return (
    getDb()
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.revokedAt)))
      .get() !== undefined
  );
}

/**
 * Who a change to these tags can move (custom roles spec §8.3): every grant
 * that selects servers by one of them, the roles holding those grants, and
 * the members those grants reach now — the role's members, or the user of a
 * personal grant. Tag selectors are evaluated live, so retagging a server is
 * an access change for all of them.
 */
function tagCoverage(orgId: string, tags: string[]) {
  if (!tags.length) return { roles: [] as { id: string; name: string; tags: string[] }[], userIds: [] as string[] };
  const db = getDb();
  const grants = db
    .select({ principalType: resourceGrants.principalType, principalId: resourceGrants.principalId, tag: resourceGrants.tag })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.orgId, orgId),
        eq(resourceGrants.resourceType, 'server'),
        eq(resourceGrants.selector, 'tag'),
        inArray(resourceGrants.tag, tags),
      ),
    )
    .all();
  const roleTags = new Map<string, Set<string>>();
  const userIds = new Set<string>();
  for (const g of grants) {
    if (g.principalType === 'role') {
      const set = roleTags.get(g.principalId) ?? new Set<string>();
      if (g.tag) set.add(g.tag);
      roleTags.set(g.principalId, set);
    } else if (g.principalType === 'user') {
      userIds.add(g.principalId);
    }
  }
  const roleIds = [...roleTags.keys()];
  const roleRows = roleIds.length
    ? db.select({ id: roles.id, name: roles.name }).from(roles).where(and(eq(roles.orgId, orgId), inArray(roles.id, roleIds))).all()
    : [];
  if (roleIds.length) {
    const members = db
      .select({ userId: roleMembers.userId })
      .from(roleMembers)
      .where(
        and(
          eq(roleMembers.orgId, orgId),
          inArray(roleMembers.roleId, roleIds),
          activeAt(roleMembers.expiresAt, new Date().toISOString()),
        ),
      )
      .all();
    for (const m of members) userIds.add(m.userId);
  }
  return {
    roles: roleRows
      .map((r) => ({ id: r.id, name: r.name, tags: [...(roleTags.get(r.id) ?? [])].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    userIds: [...userIds],
  };
}

/**
 * A server's `manage` level may come from a custom role rather than the admin
 * base role (custom roles spec §5). Such a member may edit the server, but not
 * steer the org's credentials somewhere new with it: the SSH key a server
 * logs in with, and where its connections go — host, port, user, jump host or
 * agent — stay admin decisions (ssh/jump.ts: only admins set a jump host).
 * Moving the endpoint, even with a fresh password, would still let any org
 * key a terminal or SFTP request names (`keyId`) log in wherever it now
 * points, and a new route resolves the same host from another network. A
 * new password for the same endpoint is fine. Returns the refusal, or null.
 */
function editProblem(
  req: FastifyRequest,
  existing: typeof servers.$inferSelect,
  body: Partial<z.infer<typeof createServerSchema>>,
  jumpChanged: boolean,
): { status: 403; error: string } | null {
  if (rank(req.role) >= rank('admin')) return null;
  if (body.agentId !== undefined && body.agentId !== existing.agentId) {
    return { status: 403, error: 'Only admins can route a server through an agent' };
  }
  const keyChanged =
    body.authType === 'key' &&
    (!!existing.encryptedPassword || (body.defaultKeyId !== undefined && body.defaultKeyId !== existing.defaultKeyId));
  if (keyChanged) return { status: 403, error: 'Only admins can choose the SSH key a server logs in with' };
  const endpointChanged =
    (body.host !== undefined && body.host !== existing.host) ||
    (body.port !== undefined && body.port !== existing.port) ||
    (body.username !== undefined && body.username !== existing.username);
  if (endpointChanged || jumpChanged) {
    return { status: 403, error: 'Only admins can change where a server connects: its host, port, user or jump host' };
  }
  return null;
}

export async function serverRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req) => {
    const db = getDb();
    return db
      .select()
      .from(servers)
      .where(and(eq(servers.orgId, req.orgId), accessibleServerFilter(req, servers.id)))
      .all()
      .map(sanitize);
  });

  app.post('/', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = createServerSchema.parse(req.body);
    if (
      body.authType === 'key' &&
      body.defaultKeyId &&
      !keyBelongsToOrg(req.orgId, body.defaultKeyId)
    ) {
      return reply.status(400).send({ error: 'Unknown or retired SSH key' });
    }
    if (body.jumpServerId && body.agentId) {
      return reply.status(400).send({ error: ROUTE_CONFLICT });
    }
    if (body.jumpServerId) {
      const problem = jumpHostProblem(req.orgId, undefined, body.jumpServerId);
      if (problem) return reply.status(400).send({ error: problem });
    }
    if (body.agentId && !agentUsableByOrg(req.orgId, body.agentId)) {
      return reply.status(400).send({ error: 'Unknown or revoked agent' });
    }
    const db = getDb();
    const id = nanoid();

    let encryptedPassword: string | null = null;
    if (body.authType === 'password' && body.password) {
      encryptedPassword = await vault.encrypt(body.password, id);
    }

    db.insert(servers)
      .values({
        id,
        orgId: req.orgId,
        createdBy: req.user.id,
        name: body.name,
        host: body.host,
        port: body.port,
        username: body.username,
        defaultKeyId: body.authType === 'key' ? body.defaultKeyId : undefined,
        encryptedPassword: encryptedPassword ?? null,
        tags: JSON.stringify(body.tags),
        notes: body.notes,
        jumpServerId: body.jumpServerId ?? null,
        agentId: body.agentId ?? null,
        ...(body.dockerMode && { dockerMode: body.dockerMode }),
        ...(body.dockerSocketPath && { dockerSocketPath: body.dockerSocketPath }),
        ...(body.hostKeyFingerprint && pinnedColumns(body.hostKeyFingerprint, null, req.user.id)),
      })
      .run();

    await audit(
      req,
      'server.create',
      'server',
      id,
      body.name,
      body.jumpServerId || body.agentId
        ? {
            ...(body.jumpServerId && { jumpServerId: body.jumpServerId }),
            ...(body.agentId && { agentId: body.agentId }),
          }
        : undefined,
    );
    if (body.hostKeyFingerprint) {
      await audit(req, 'server.host_key_pinned', 'server', id, body.name, {
        fingerprint: body.hostKeyFingerprint,
      });
    }
    const row = db.select().from(servers).where(eq(servers.id, id)).get()!;
    return reply.status(201).send(sanitize(row));
  });

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    // Not granted reads as not found, so a restricted member cannot probe ids
    if (!canAccessServer(req, id)) return reply.status(404).send({ error: 'Not found' });
    const server = db
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), eq(servers.orgId, req.orgId)))
      .get();
    if (!server) return reply.status(404).send({ error: 'Not found' });
    return sanitize(server);
  });

  /**
   * Edit a server: `manage` on it (admins, or a custom role that manages it).
   * Changing its tags moves every tag-selected grant, so it is audited with
   * the roles whose coverage changed, and whatever a member lost closes.
   */
  app.patch('/:id', { preHandler: requireServer('edit') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createServerSchema.partial().parse(req.body);
    const db = getDb();

    const existing = db
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), eq(servers.orgId, req.orgId)))
      .get();
    if (!existing) return reply.status(404).send({ error: 'Not found' });
    const jumpChanged =
      body.jumpServerId !== undefined && (body.jumpServerId ?? null) !== existing.jumpServerId;
    // Before anything that would tell a non-admin which agents or servers exist
    const refused = editProblem(req, existing, body, jumpChanged);
    if (refused) return reply.status(refused.status).send({ error: refused.error });
    if (body.authType === 'key' && body.defaultKeyId && !keyBelongsToOrg(req.orgId, body.defaultKeyId)) {
      return reply.status(400).send({ error: 'Unknown or retired SSH key' });
    }
    // Re-sending the agent a server already has is a no-op, even once it is revoked
    if (body.agentId && body.agentId !== existing.agentId && !agentUsableByOrg(req.orgId, body.agentId)) {
      return reply.status(400).send({ error: 'Unknown or revoked agent' });
    }

    if (jumpChanged && body.jumpServerId) {
      const problem = jumpHostProblem(req.orgId, id, body.jumpServerId);
      if (problem) return reply.status(400).send({ error: problem });
    }
    const nextJump = jumpChanged ? (body.jumpServerId ?? null) : existing.jumpServerId;
    const nextAgent = body.agentId !== undefined ? body.agentId : existing.agentId;
    if (nextJump && nextAgent) return reply.status(400).send({ error: ROUTE_CONFLICT });

    // Tags select servers for roles and grants (spec §8.3): note who they reach before the change
    const tagsBefore = parseTags(existing.tags);
    const tagsAfter = body.tags !== undefined ? [...new Set(body.tags)] : tagsBefore;
    const tagsChanged = [
      ...tagsBefore.filter((t) => !tagsAfter.includes(t)),
      ...tagsAfter.filter((t) => !tagsBefore.includes(t)),
    ];
    const coverage = tagCoverage(req.orgId, tagsChanged);
    const accessBefore = coverage.userIds.length ? snapshotAccess(req.orgId, coverage.userIds) : null;

    const updateData: Partial<typeof servers.$inferInsert> = {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.host !== undefined && { host: body.host }),
      ...(body.port !== undefined && { port: body.port }),
      ...(body.username !== undefined && { username: body.username }),
      ...(body.tags !== undefined && { tags: JSON.stringify(body.tags) }),
      ...(body.notes !== undefined && { notes: body.notes }),
      ...(jumpChanged && { jumpServerId: body.jumpServerId ?? null }),
      ...(body.agentId !== undefined && { agentId: body.agentId }),
      ...(body.dockerMode !== undefined && { dockerMode: body.dockerMode }),
      updatedAt: new Date().toISOString(),
    };

    // A different socket is a different daemon: what the last probe found no longer applies
    const dockerSocketChanged =
      body.dockerSocketPath !== undefined && (body.dockerSocketPath ?? null) !== existing.dockerSocketPath;
    if (dockerSocketChanged) {
      Object.assign(updateData, { dockerSocketPath: body.dockerSocketPath ?? null }, clearedDetection());
    }
    const dockerModeChanged = body.dockerMode !== undefined && body.dockerMode !== existing.dockerMode;

    // A new host or port is a different endpoint: the old key says nothing about
    // it. A new route is not: the agent is untrusted transport, so the pinned
    // key stays and must still match through it — forgetting it here would let
    // whoever holds the agent's token answer the next connection with any key.
    const agentChanged = body.agentId !== undefined && body.agentId !== existing.agentId;
    const endpointChanged =
      (body.host !== undefined && body.host !== existing.host) ||
      (body.port !== undefined && body.port !== existing.port);
    if (body.hostKeyFingerprint) {
      if (body.hostKeyFingerprint !== existing.hostKeyFingerprint || endpointChanged) {
        Object.assign(updateData, pinnedColumns(body.hostKeyFingerprint, null, req.user.id));
      }
    } else if (endpointChanged && (existing.hostKeyFingerprint || existing.hostKeyMismatchFingerprint)) {
      Object.assign(updateData, clearedColumns());
    }

    if (body.authType === 'password' && body.password) {
      updateData.encryptedPassword = await vault.encrypt(body.password, id);
      updateData.defaultKeyId = null; // clear key when switching to password
    } else if (body.authType === 'key') {
      updateData.defaultKeyId = body.defaultKeyId;
      updateData.encryptedPassword = null;
    }

    db.update(servers).set(updateData).where(eq(servers.id, id)).run();
    // Pooled SFTP and Docker connections hold the old host/credentials/route — force a reconnect
    evictWithDependents(req.orgId, id);
    if (tagsChanged.length) {
      // Members who reached this server only through a removed tag lose what they had open on it
      const closed = accessBefore ? revokeAfterChange(req.orgId, coverage.userIds, accessBefore) : new Map();
      await audit(req, 'server.tags_change', 'server', id, existing.name, {
        before: tagsBefore,
        after: tagsAfter,
        added: tagsAfter.filter((t) => !tagsBefore.includes(t)),
        removed: tagsBefore.filter((t) => !tagsAfter.includes(t)),
        affectedRoles: coverage.roles,
        affectedMembers: coverage.userIds.length,
        ...(closed.size && { revokedMembers: [...closed.keys()] }),
      });
    }
    await audit(
      req,
      'server.update',
      'server',
      id,
      existing.name,
      jumpChanged || agentChanged || dockerModeChanged || dockerSocketChanged
        ? {
            ...(jumpChanged && { jumpServerId: { from: existing.jumpServerId, to: body.jumpServerId ?? null } }),
            ...(agentChanged && { agentId: { from: existing.agentId, to: body.agentId } }),
            ...(dockerModeChanged && { dockerMode: { from: existing.dockerMode, to: body.dockerMode } }),
            ...(dockerSocketChanged && {
              dockerSocketPath: { from: existing.dockerSocketPath, to: body.dockerSocketPath ?? null },
            }),
          }
        : undefined,
    );
    if (updateData.hostKeyFingerprint !== undefined) {
      if (existing.hostKeyMismatchFingerprint) resolveHostKeyAlert(req.orgId, id);
      if (updateData.hostKeyFingerprint) {
        await audit(req, 'server.host_key_pinned', 'server', id, existing.name, {
          fingerprint: updateData.hostKeyFingerprint,
          previous: existing.hostKeyFingerprint,
        });
      } else {
        await audit(req, 'server.host_key_cleared', 'server', id, existing.name, {
          reason: 'endpoint_changed',
          previous: existing.hostKeyFingerprint,
          from: `${existing.host}:${existing.port}`,
          to: `${updateData.host ?? existing.host}:${updateData.port ?? existing.port}`,
        });
      }
    }
    const row = db.select().from(servers).where(eq(servers.id, id)).get()!;
    return sanitize(row);
  });

  app.delete('/:id', { preHandler: requireServer('delete') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const existing = db
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), eq(servers.orgId, req.orgId)))
      .get();
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    // Servers behind this one fall back to direct connections (ON DELETE SET NULL)
    const dependents = serversBehind(req.orgId, id);
    db.delete(servers).where(eq(servers.id, id)).run();
    for (const serverId of [id, ...dependents]) {
      evictServer(req.orgId, serverId);
      evictDockerServer(req.orgId, serverId);
      evictKubeServer(req.orgId, serverId);
    }
    await audit(req, 'server.delete', 'server', id, existing.name);
    return reply.status(204).send();
  });
}
