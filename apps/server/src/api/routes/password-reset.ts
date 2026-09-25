import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { PasswordResetPreview } from '@smt/shared';
import { getDb } from '../../db/index.js';
import { memberships, passwordResets, users } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { invalidateUserSessions } from '../../auth/session.js';
import { hashResetToken, resetState } from '../../auth/password-reset.js';
import { maskEmail } from '../../auth/invite.js';
import { audit } from '../../audit/index.js';
import { revokeLiveAccess } from '../../auth/revoke.js';

// Same bounds as change-password and invite registration
const resetSchema = z.object({ password: z.string().min(8).max(200) });

/**
 * Why a reset issued for `reset.orgId` may no longer be redeemed, if it may
 * not. Issuing checked this once; by redemption the person may have been
 * suspended, removed, or joined another org — where the issuing admin has no
 * say over their account.
 */
function redemptionBlocker(reset: { userId: string; orgId: string }): { status: number; error: string } | null {
  const db = getDb();
  const membership = db
    .select({ status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.userId, reset.userId), eq(memberships.orgId, reset.orgId)))
    .get();
  if (!membership || membership.status !== 'active') {
    return {
      status: 410,
      error: 'This reset link is no longer valid because your membership has changed. Ask an admin for help.',
    };
  }
  const elsewhere = db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(and(eq(memberships.userId, reset.userId), ne(memberships.orgId, reset.orgId)))
    .get();
  if (elsewhere) {
    return {
      status: 409,
      error:
        'This reset link can no longer be used because your account now belongs to more than one organization. Sign in, or ask an admin for help.',
    };
  }
  return null;
}

function findReset(token: string) {
  return getDb()
    .select()
    .from(passwordResets)
    .where(eq(passwordResets.tokenHash, hashResetToken(token)))
    .get();
}

/**
 * The unauthenticated half of an admin-issued password reset: check a link,
 * then redeem it. The link itself is the credential, so it is single-use,
 * short-lived and stored only as a hash.
 */
export async function publicPasswordResetRoutes(app: FastifyInstance) {
  app.get('/:token', async (req, reply): Promise<PasswordResetPreview | undefined> => {
    const { token } = req.params as { token: string };
    const reset = findReset(token);
    if (!reset) return reply.status(404).send({ error: 'Reset link not found' });

    const user = getDb().select({ email: users.email }).from(users).where(eq(users.id, reset.userId)).get();
    if (!user) return reply.status(404).send({ error: 'Reset link not found' });

    return { emailHint: maskEmail(user.email), state: resetState(reset) };
  });

  app.post(
    '/:token',
    // Tighter than the global limit, like invite accept
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const body = resetSchema.parse(req.body);
      const db = getDb();

      const reset = findReset(token);
      if (!reset) return reply.status(404).send({ error: 'Reset link not found' });

      const state = resetState(reset);
      if (state !== 'valid') {
        return reply
          .status(410)
          .send({ error: state === 'used' ? 'This reset link was already used' : 'This reset link has expired' });
      }

      const user = db.select().from(users).where(eq(users.id, reset.userId)).get();
      if (!user) return reply.status(404).send({ error: 'Reset link not found' });

      const blocker = redemptionBlocker(reset);
      if (blocker) {
        // Void it for good: whatever made it unusable should not be undone by retrying later
        db.delete(passwordResets).where(eq(passwordResets.id, reset.id)).run();
        return reply.status(blocker.status).send({ error: blocker.error });
      }

      const passwordHash = await hashPassword(body.password);
      const now = new Date().toISOString();

      // Claim the link first; the usedAt guard makes a concurrent second redeem a no-op.
      const claimed = db
        .update(passwordResets)
        .set({ usedAt: now })
        .where(and(eq(passwordResets.id, reset.id), isNull(passwordResets.usedAt)))
        .run().changes;
      if (claimed === 0) return reply.status(410).send({ error: 'This reset link was already used' });

      db.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, user.id)).run();
      // Whoever held the old password may hold a session too
      const revoked = invalidateUserSessions(user.id);
      // ...and whatever those sessions opened: terminals, file sessions, agent chats
      const live = revokeLiveAccess(user.id);

      // Unauthenticated route: attribute the audit row to the account that was reset
      req.user = { id: user.id, email: user.email, displayName: user.displayName };
      req.orgId = reset.orgId;
      await audit(req, 'user.password_reset_used', 'user', user.id, user.email, {
        resetId: reset.id,
        sessionsRevoked: revoked,
        live,
      });

      return { ok: true };
    },
  );
}
