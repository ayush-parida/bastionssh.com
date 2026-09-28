import type { FastifyRequest } from 'fastify';
import { getDb } from '../db/index.js';
import { auditLog } from '../db/schema.js';
import type { AuditAction } from '@smt/shared';
import { nanoid } from 'nanoid';

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

/** A person recorded as the actor of work that outlives their request (e.g. a bulk key rotation). */
export interface AuditActor {
  orgId: string;
  userId: string;
  email: string;
  ip?: string;
  userAgent?: string;
}

/** The actor behind a request, captured so background work can be audited under their name. */
export function auditActorOf(req: FastifyRequest): AuditActor {
  return {
    orgId: req.orgId,
    userId: req.user.id,
    email: req.user.email,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  };
}

/** Like {@link audit}, for an actor captured earlier with {@link auditActorOf}. */
export function auditAs(
  actor: AuditActor,
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
        orgId: actor.orgId,
        actorId: actor.userId,
        actorEmail: actor.email,
        action,
        resourceType,
        resourceId,
        resourceName,
        ipAddress: actor.ip,
        userAgent: actor.userAgent,
        metadata: metadata ? JSON.stringify(metadata) : undefined,
      })
      .run();
  } catch {
    // Same rule as audit(): never break the caller
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
  try {
    getDb()
      .insert(auditLog)
      .values({
        id: nanoid(),
        orgId,
        actorId: SYSTEM_ACTOR.id,
        actorEmail: SYSTEM_ACTOR.email,
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
