import type { FastifyRequest } from 'fastify';
import { getDb } from '../db/index.js';
import { auditLog, users } from '../db/schema.js';
import type { AuditAction } from '@smt/shared';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';

export async function audit(
  req: FastifyRequest,
  action: AuditAction,
  resourceType: string,
  resourceId?: string,
  resourceName?: string,
  metadata?: Record<string, unknown>,
) {
  try {
    const db = getDb();
    db.insert(auditLog)
      .values({
        id: nanoid(),
        orgId: req.orgId,
        actorId: req.user.id,
        actorEmail: req.user.email,
        action,
        resourceType,
        resourceId,
        resourceName,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        metadata: metadata ? JSON.stringify(metadata) : undefined,
      })
      .run();
  } catch {
    // Audit failures must never break the primary request
  }
}

/** Actor recorded for events the server raises on its own (health checks, cron, TOFU). */
export const SYSTEM_ACTOR = { id: 'system', email: 'system' } as const;

/**
 * Audit an event with no request behind it — a background health check or a
 * scheduled job noticing something. Recorded under {@link SYSTEM_ACTOR}.
 */
export function auditSystem(
  orgId: string,
  action: AuditAction,
  resourceType: string,
  resourceId?: string,
  resourceName?: string,
  metadata?: Record<string, unknown>,
) {
  auditActor(SYSTEM_ACTOR, orgId, action, resourceType, resourceId, resourceName, metadata);
}

/**
 * Audit an event on behalf of a user when no request is at hand — e.g. an SSH
 * hop opened deep inside a connection for them. Falls back to
 * {@link SYSTEM_ACTOR} when there is no user or they no longer exist.
 */
export function auditUser(
  orgId: string,
  userId: string | undefined,
  action: AuditAction,
  resourceType: string,
  resourceId?: string,
  resourceName?: string,
  metadata?: Record<string, unknown>,
) {
  let actor: { id: string; email: string } = SYSTEM_ACTOR;
  if (userId) {
    try {
      const user = getDb().select({ email: users.email }).from(users).where(eq(users.id, userId)).get();
      if (user) actor = { id: userId, email: user.email };
    } catch {
      // Recorded as system rather than not at all
    }
  }
  auditActor(actor, orgId, action, resourceType, resourceId, resourceName, metadata);
}

function auditActor(
  actor: { id: string; email: string },
  orgId: string,
  action: AuditAction,
  resourceType: string,
  resourceId?: string,
  resourceName?: string,
  metadata?: Record<string, unknown>,
) {
  try {
    getDb()
      .insert(auditLog)
      .values({
        id: nanoid(),
        orgId,
        actorId: actor.id,
        actorEmail: actor.email,
        action,
        resourceType,
        resourceId,
        resourceName,
        metadata: metadata ? JSON.stringify(metadata) : undefined,
      })
      .run();
  } catch {
    // Same rule as audit(): never break the caller
  }
}
