import { createHash } from 'crypto';
import { getDb } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** `lastSeenAt` is written at most this often per session — it is not an access log. */
export const LAST_SEEN_THROTTLE_MS = 60 * 1000;

export interface SessionContext {
  ipAddress?: string | null;
  userAgent?: string | null;
  activeOrgId?: string | null;
}

export async function createSession(userId: string, context: SessionContext = {}) {
  const db = getDb();
  const id = nanoid(48);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  db.insert(sessions)
    .values({
      id,
      userId,
      expiresAt,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      ipAddress: context.ipAddress ?? null,
      // Browsers send long strings; nothing useful lives past the first few hundred chars
      userAgent: context.userAgent?.slice(0, 500) ?? null,
      activeOrgId: context.activeOrgId ?? null,
    })
    .run();
  return { id, userId, expiresAt };
}

export async function validateSession(sessionId: string) {
  const db = getDb();
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    return null;
  }
  return session;
}

/** Record activity on a session, but only once per throttle window. Never throws. */
export function touchSession(
  session: { id: string; lastSeenAt: string | null },
  ipAddress: string | undefined,
  now = new Date(),
) {
  if (session.lastSeenAt && now.getTime() - new Date(session.lastSeenAt).getTime() < LAST_SEEN_THROTTLE_MS) {
    return;
  }
  try {
    getDb()
      .update(sessions)
      .set({ lastSeenAt: now.toISOString(), ...(ipAddress && { ipAddress }) })
      .where(eq(sessions.id, session.id))
      .run();
  } catch {
    /* bookkeeping only */
  }
}

export async function invalidateSession(sessionId: string) {
  const db = getDb();
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

/** End every session a user holds — after suspension, a password reset, or "sign out everywhere". */
export function invalidateUserSessions(userId: string): number {
  return getDb().delete(sessions).where(eq(sessions.userId, userId)).run().changes;
}

/**
 * The id the API exposes for a session. The real id is the cookie value, so
 * handing it out — even to its owner — would let anything that can read the
 * list (a script with an API token, an XSS) lift another browser's session.
 */
export function publicSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

/** Resolve a public handle back to one of this user's sessions. */
export function findUserSession(userId: string, publicId: string) {
  return getDb()
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .all()
    .find((s) => publicSessionId(s.id) === publicId);
}

export function setActiveOrg(sessionId: string, orgId: string) {
  getDb()
    .update(sessions)
    .set({ activeOrgId: orgId })
    .where(eq(sessions.id, sessionId))
    .run();
}
