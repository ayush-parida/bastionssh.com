import { getDb } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function createSession(userId: string) {
  const db = getDb();
  const id = nanoid(48);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.insert(sessions).values({ id, userId, expiresAt }).run();
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

export async function invalidateSession(sessionId: string) {
  const db = getDb();
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}
