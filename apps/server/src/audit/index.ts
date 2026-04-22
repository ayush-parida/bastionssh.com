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
