import { createHash, createHmac } from 'crypto';
import { isIP } from 'net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, count, eq, isNull, lt, ne, or } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { loginFailures, memberships, sessions, userDevices } from '../db/schema.js';
import { config } from '../config/index.js';
import { auditForAccount } from '../audit/index.js';
import { notifyAccountOwner } from './passkey.js';

// ── Known devices ────────────────────────────────────────────────────────────

/** A device not signed in from for this long counts as new again. */
export const DEVICE_RETENTION_DAYS = 180;

/**
 * "Firefox on Linux". Deliberately coarse: a browser update must not make a
 * device new, so versions are ignored. Non-browsers get their product token.
 */
export function deviceFamily(userAgent: string | undefined | null): string {
  const ua = userAgent ?? '';
  const browser = /\bEdg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /\bOPR\/|\bOpera\b/.test(ua)
      ? 'Opera'
      : /\bFirefox\/|\bFxiOS\//.test(ua)
        ? 'Firefox'
        : /\bChrome\/|\bCriOS\/|\bChromium\//.test(ua)
          ? 'Chrome'
          : /\bVersion\/.*\bSafari\//.test(ua)
            ? 'Safari'
            : (/^([A-Za-z][\w.-]{0,40})\//.exec(ua)?.[1] ?? 'Unknown browser');
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /CrOS/.test(ua)
          ? 'ChromeOS'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  return os ? `${browser} on ${os}` : browser;
}

/** The eight hextets of an IPv6 address, zone id dropped. */
function expandIPv6(ip: string): string[] {
  const [head = '', tail] = ip.split('%')[0]!.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  // An embedded IPv4 tail (::1.2.3.4) is two hextets
  const last = right.length ? right : left;
  const v4 = last.length && last[last.length - 1]!.includes('.') ? last.pop()! : null;
  if (v4) {
    const [a = 0, b = 0, c = 0, d = 0] = v4.split('.').map(Number);
    last.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
  }
  const fill = tail !== undefined ? Array(8 - left.length - right.length).fill('0') : [];
  return [...left, ...fill, ...right].map((h) => (parseInt(h, 16) || 0).toString(16));
}

/** The client's network, coarsened: 203.0.113.0/24, or 2001:db8:1::/48 for IPv6. */
export function ipPrefix(ip: string | undefined | null): string {
  let addr = ip ?? '';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) addr = mapped[1]!;
  if (isIP(addr) === 4) {
    const [a, b, c] = addr.split('.');
    return `${a}.${b}.${c}.0/24`;
  }
  if (isIP(addr.split('%')[0]!) === 6) {
    const h = expandIPv6(addr);
    return `${h[0]}:${h[1]}:${h[2]}::/48`;
  }
  return 'unknown';
}

export function deviceHash(label: string, prefix: string): string {
  return createHash('sha256').update(`${label}|${prefix}`).digest('hex');
}

export interface SignInDevice {
  isNew: boolean;
  label: string;
  ipPrefix: string;
}

/**
 * Remember the device behind a completed sign-in and say whether the account
 * has used it before. An account with no devices on record yet (every account
 * right after this shipped) first learns them from its other sessions; if it
 * still has none, this is its first sign-in and is not reported as new.
 */
export function recordSignInDevice(
  userId: string,
  ip: string | undefined,
  userAgent: string | undefined,
  currentSessionId?: string,
  now = new Date(),
): SignInDevice {
  const db = getDb();
  const label = deviceFamily(userAgent);
  const prefix = ipPrefix(ip);
  const hash = deviceHash(label, prefix);
  const at = now.toISOString();
  const known = () =>
    db
      .select({ id: userDevices.id })
      .from(userDevices)
      .where(and(eq(userDevices.userId, userId), eq(userDevices.deviceHash, hash)))
      .get();
  const total = () =>
    db.select({ n: count() }).from(userDevices).where(eq(userDevices.userId, userId)).get()?.n ?? 0;

  let seen = total();
  if (seen === 0) {
    const others = db
      .select({ ipAddress: sessions.ipAddress, userAgent: sessions.userAgent, createdAt: sessions.createdAt })
      .from(sessions)
      .where(currentSessionId ? and(eq(sessions.userId, userId), ne(sessions.id, currentSessionId)) : eq(sessions.userId, userId))
      .all();
    for (const s of others) {
      const l = deviceFamily(s.userAgent);
      const p = ipPrefix(s.ipAddress);
      db.insert(userDevices)
        .values({ id: nanoid(), userId, deviceHash: deviceHash(l, p), label: l, ipPrefix: p, firstSeenAt: s.createdAt, lastSeenAt: s.createdAt })
        .onConflictDoNothing()
        .run();
    }
    seen = total();
  }

  const existing = known();
  if (existing) {
    db.update(userDevices).set({ lastSeenAt: at }).where(eq(userDevices.id, existing.id)).run();
    return { isNew: false, label, ipPrefix: prefix };
  }
  const inserted = db
    .insert(userDevices)
    .values({ id: nanoid(), userId, deviceHash: hash, label, ipPrefix: prefix, firstSeenAt: at, lastSeenAt: at })
    .onConflictDoNothing()
    .run().changes;
  // A concurrent sign-in from the same device already recorded (and reported) it
  return { isNew: inserted > 0 && seen > 0, label, ipPrefix: prefix };
}

export function notifyNewDeviceSignIn(
  user: { email: string; displayName: string },
  device: SignInDevice,
  ip: string,
) {
  notifyAccountOwner(
    user,
    `New sign-in to your ${config.webauthn.rpName} account`,
    `Your ${config.webauthn.rpName} account was signed in to from a device or network it has not used before: ${device.label}, from ${ip} (${device.ipPrefix}), on ${new Date().toUTCString()}.`,
    'new-device sign-in',
    'If this was not you, change your password and sign out your other sessions under Settings, or ask an organization admin to reset your password and passkeys right away.',
  );
}

// ── Failed password sign-ins ─────────────────────────────────────────────────

/** Wrong passwords within FAILED_LOGIN_WINDOW_MS before password sign-in is paused. */
export const FAILED_LOGIN_THRESHOLD = 5;
export const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** The first pause; each further one in a row doubles, up to the maximum. */
export const LOCKOUT_BASE_MS = 60 * 1000;
/**
 * Kept short on purpose: anyone who knows an address can trigger the pause,
 * so it must not become a way to keep an owner out. A passkey sign-in is
 * never paused and clears it.
 */
export const LOCKOUT_MAX_MS = 15 * 60 * 1000;
/** A quiet day forgets the backoff. */
export const LOCKOUT_RESET_MS = 24 * 60 * 60 * 1000;
/** At most one "failed sign-ins" email per account in this long. */
const LOCK_NOTICE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * What failed sign-ins are counted under. An HMAC of the email as typed, so
 * rows exist for addresses with no account too (and look the same), and the
 * table does not list who has been targeted.
 */
export function accountKey(email: string): string {
  return createHmac('sha256', config.sessionSecret).update(`login-lockout:${email.trim().toLowerCase()}`).digest('hex');
}

export interface Lockout {
  lockedUntil: string;
  retryAfterSeconds: number;
}

export function lockoutStatus(key: string, now = new Date()): Lockout | null {
  const row = getDb().select().from(loginFailures).where(eq(loginFailures.accountKey, key)).get();
  if (!row?.lockedUntil) return null;
  const ms = Date.parse(row.lockedUntil) - now.getTime();
  if (ms <= 0) return null;
  return { lockedUntil: row.lockedUntil, retryAfterSeconds: Math.ceil(ms / 1000) };
}

export interface FailedAttempt {
  /** Failures in the current window, including this one (0 right after a lock starts). */
  failures: number;
  /** Set when this attempt started a pause. */
  locked: (Lockout & { lockouts: number }) | null;
  /** Whether to email the owner about it (throttled). */
  notify: boolean;
}

/**
 * Count one password attempt against the account. Called before the password
 * is checked, so parallel guesses cannot all slip past the threshold while
 * their hashes are computed; a correct password then clears the count.
 */
export function recordFailedLogin(key: string, now = new Date()): FailedAttempt {
  const db = getDb();
  const t = now.getTime();
  const at = now.toISOString();
  const row = db.select().from(loginFailures).where(eq(loginFailures.accountKey, key)).get();

  const quiet = !row || t - Date.parse(row.lastFailureAt) >= LOCKOUT_RESET_MS;
  const windowOpen = row && !quiet && t - Date.parse(row.windowStartedAt) < FAILED_LOGIN_WINDOW_MS;
  let failures = (windowOpen ? row.failures : 0) + 1;
  let windowStartedAt = windowOpen ? row.windowStartedAt : at;
  let lockouts = quiet ? 0 : row.lockouts;
  let lockedUntil = quiet ? null : row.lockedUntil;
  let notifiedAt = row?.notifiedAt ?? null;
  let locked: FailedAttempt['locked'] = null;
  let notify = false;

  if (failures >= FAILED_LOGIN_THRESHOLD) {
    const ms = Math.min(LOCKOUT_BASE_MS * 2 ** lockouts, LOCKOUT_MAX_MS);
    lockouts += 1;
    lockedUntil = new Date(t + ms).toISOString();
    locked = { lockedUntil, retryAfterSeconds: Math.ceil(ms / 1000), lockouts };
    failures = 0;
    windowStartedAt = at;
    notify = !notifiedAt || t - Date.parse(notifiedAt) >= LOCK_NOTICE_INTERVAL_MS;
    if (notify) notifiedAt = at;
  }

  const values = { failures, windowStartedAt, lockedUntil, lockouts, lastFailureAt: at, notifiedAt };
  db.insert(loginFailures)
    .values({ accountKey: key, ...values })
    .onConflictDoUpdate({ target: loginFailures.accountKey, set: values })
    .run();
  return { failures, locked, notify };
}

/** A successful sign-in (password or passkey) forgets the failures and any pause. */
export function clearLoginFailures(key: string) {
  getDb().delete(loginFailures).where(eq(loginFailures.accountKey, key)).run();
}

/** Rows that can no longer lock or back off anything. Run by the daily maintenance job. */
export function pruneLoginFailures(now = new Date()): number {
  const quietSince = new Date(now.getTime() - LOCKOUT_RESET_MS).toISOString();
  return getDb()
    .delete(loginFailures)
    .where(
      and(
        lt(loginFailures.lastFailureAt, quietSince),
        or(isNull(loginFailures.lockedUntil), lt(loginFailures.lockedUntil, now.toISOString())),
      ),
    )
    .run().changes;
}

export function pruneStaleDevices(now = new Date()): number {
  const cutoff = new Date(now.getTime() - DEVICE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return getDb().delete(userDevices).where(lt(userDevices.lastSeenAt, cutoff)).run().changes;
}

export function notifyAccountLocked(
  user: { email: string; displayName: string },
  lock: Lockout,
  ip: string,
) {
  const minutes = Math.max(1, Math.round(lock.retryAfterSeconds / 60));
  notifyAccountOwner(
    user,
    `Failed sign-in attempts on your ${config.webauthn.rpName} account`,
    `There were ${FAILED_LOGIN_THRESHOLD} failed password attempts on your ${config.webauthn.rpName} account in a short time, the latest from ${ip} on ${new Date().toUTCString()}. Signing in with a password is paused for ${minutes} minute${minutes === 1 ? '' : 's'}; signing in with a passkey still works.`,
    'failed sign-in',
    'If this was not you, someone may be guessing your password. Make sure it is long and not used anywhere else, and add a passkey under Settings if you have not.',
  );
}

/** Refuse a password sign-in while the account's password step is paused. */
export function sendLocked(reply: FastifyReply, lock: Lockout) {
  const minutes = Math.max(1, Math.ceil(lock.retryAfterSeconds / 60));
  return reply
    .status(429)
    .header('Retry-After', String(lock.retryAfterSeconds))
    .send({
      error: `Too many failed sign-in attempts. Try your password again in ${minutes} minute${minutes === 1 ? '' : 's'}, or sign in with a passkey.`,
      code: 'ACCOUNT_LOCKED',
      retryAfter: lock.retryAfterSeconds,
    });
}

/**
 * A wrong password for an existing account: audited into each of its orgs,
 * and, when this attempt started a pause, that too, with the owner emailed.
 */
export function reportFailedPassword(
  req: FastifyRequest,
  user: { id: string; email: string; displayName: string },
  attempt: FailedAttempt,
  details: Record<string, unknown> = {},
) {
  const orgIds = getDb()
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(eq(memberships.userId, user.id))
    .all()
    .map((m) => m.orgId);
  auditForAccount(req, user, orgIds, 'user.login_failed', { reason: 'bad_password', ...details });
  if (attempt.locked) {
    auditForAccount(req, user, orgIds, 'user.login_locked', {
      failures: FAILED_LOGIN_THRESHOLD,
      lockedForSeconds: attempt.locked.retryAfterSeconds,
      lockouts: attempt.locked.lockouts,
      ...details,
    });
    if (attempt.notify) notifyAccountLocked(user, attempt.locked, req.ip);
  }
}
