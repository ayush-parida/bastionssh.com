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

/**
 * Audit a request that is not signed in (a failed or blocked sign-in) on
 * behalf of the account it names, into each org that account belongs to.
 */
export function auditForAccount(
  req: FastifyRequest,
  actor: { id: string; email: string },
  orgIds: string[],
  action: AuditAction,
  metadata?: Record<string, unknown>,
) {
  for (const orgId of orgIds) {
    try {
      getDb()
        .insert(auditLog)
        .values({
          id: nanoid(),
          orgId,
          actorId: actor.id,
          actorEmail: actor.email,
          action,
          resourceType: 'user',
          resourceId: actor.id,
          resourceName: actor.email,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          metadata: metadata ? JSON.stringify(metadata) : undefined,
        })
        .run();
    } catch {
      // Same rule as audit(): never break the caller
    }
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
