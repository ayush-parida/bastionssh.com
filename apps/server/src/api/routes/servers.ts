import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CloudProvider, CloudServerState, Server } from '@smt/shared';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { accessibleServerFilter, canAccessServer } from '../../auth/server-access.js';
import { getDb } from '../../db/index.js';
import { servers, sshKeys } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { audit } from '../../audit/index.js';
import { vault } from '../../vault/index.js';
import { evictServer } from '../../ssh/sftp.js';
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
  };
}

/**
 * Drop pooled SFTP connections to a server and to every server reached through
 * it — theirs run over a tunnel built with this server's old settings.
 */
function evictWithDependents(orgId: string, serverId: string) {
  for (const id of [serverId, ...serversBehind(orgId, serverId)]) evictServer(orgId, id);
}

/** A server may only point at a vaulted key from its own org. */
function keyBelongsToOrg(orgId: string, keyId: string): boolean {
  return (
    getDb()
      .select({ id: sshKeys.id })
      .from(sshKeys)
      .where(and(eq(sshKeys.id, keyId), eq(sshKeys.orgId, orgId)))
      .get() !== undefined
  );
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
      return reply.status(400).send({ error: 'Unknown SSH key' });
    }
    if (body.jumpServerId) {
      const problem = jumpHostProblem(req.orgId, undefined, body.jumpServerId);
      if (problem) return reply.status(400).send({ error: problem });
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
        ...(body.hostKeyFingerprint && pinnedColumns(body.hostKeyFingerprint, null, req.user.id)),
      })
      .run();

    await audit(
      req,
      'server.create',
      'server',
      id,
      body.name,
      body.jumpServerId ? { jumpServerId: body.jumpServerId } : undefined,
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

  app.patch('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createServerSchema.partial().parse(req.body);
    if (
      body.authType === 'key' &&
      body.defaultKeyId &&
      !keyBelongsToOrg(req.orgId, body.defaultKeyId)
    ) {
      return reply.status(400).send({ error: 'Unknown SSH key' });
    }
    const db = getDb();

    const existing = db
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), eq(servers.orgId, req.orgId)))
      .get();
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    const jumpChanged =
      body.jumpServerId !== undefined && (body.jumpServerId ?? null) !== existing.jumpServerId;
    if (jumpChanged && body.jumpServerId) {
      const problem = jumpHostProblem(req.orgId, id, body.jumpServerId);
      if (problem) return reply.status(400).send({ error: problem });
    }

    const updateData: Partial<typeof servers.$inferInsert> = {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.host !== undefined && { host: body.host }),
      ...(body.port !== undefined && { port: body.port }),
      ...(body.username !== undefined && { username: body.username }),
      ...(body.tags !== undefined && { tags: JSON.stringify(body.tags) }),
      ...(body.notes !== undefined && { notes: body.notes }),
      ...(jumpChanged && { jumpServerId: body.jumpServerId ?? null }),
      updatedAt: new Date().toISOString(),
    };

    // A new host or port is a different endpoint: the old key says nothing about it
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
    // Pooled SFTP channels hold the old host/credentials/route — force a reconnect
    evictWithDependents(req.orgId, id);
    await audit(
      req,
      'server.update',
      'server',
      id,
      existing.name,
      jumpChanged ? { jumpServerId: { from: existing.jumpServerId, to: body.jumpServerId ?? null } } : undefined,
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

  app.delete('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
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
    for (const serverId of [id, ...dependents]) evictServer(req.orgId, serverId);
    await audit(req, 'server.delete', 'server', id, existing.name);
    return reply.status(204).send();
  });
}
