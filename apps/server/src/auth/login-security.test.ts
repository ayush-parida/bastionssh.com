import { describe, it, expect, beforeAll } from 'vitest';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { runMigrations } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { loginFailures, userDevices, users } from '../db/schema.js';
import {
  deviceFamily,
  ipPrefix,
  lockoutStatus,
  LOCKOUT_MAX_MS,
  LOCKOUT_RESET_MS,
  FAILED_LOGIN_THRESHOLD,
  FAILED_LOGIN_WINDOW_MS,
  pruneLoginFailures,
  pruneStaleDevices,
  recordFailedLogin,
  recordSignInDevice,
} from './login-security.js';

describe('login security helpers', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  describe('deviceFamily', () => {
    it.each([
      ['Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0', 'Firefox on Linux'],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
        'Edge on Windows',
      ],
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
        'Safari on macOS',
      ],
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1',
        'Chrome on iOS',
      ],
      [
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
        'Chrome on Android',
      ],
      ['curl/8.4.0', 'curl'],
      ['', 'Unknown browser'],
    ])('%s → %s', (ua, expected) => {
      expect(deviceFamily(ua)).toBe(expected);
    });
  });

  describe('ipPrefix', () => {
    it.each([
      ['203.0.113.77', '203.0.113.0/24'],
      ['::ffff:203.0.113.77', '203.0.113.0/24'],
      ['2001:db8:1:2::5', '2001:db8:1::/48'],
      ['2001:db8::1', '2001:db8:0::/48'],
      ['::1', '0:0:0::/48'],
      ['fe80::1%eth0', 'fe80:0:0::/48'],
      ['not-an-ip', 'unknown'],
      [undefined, 'unknown'],
    ])('%s → %s', (ip, expected) => {
      expect(ipPrefix(ip)).toBe(expected);
    });
  });

  describe('recordFailedLogin', () => {
    const key = () => `test-${nanoid()}`;

    it('locks at the threshold and doubles each pause up to the cap', () => {
      const k = key();
      let t = Date.parse('2026-01-01T00:00:00Z');
      const pauses: number[] = [];
      for (let round = 0; round < 7; round++) {
        let last;
        for (let i = 0; i < FAILED_LOGIN_THRESHOLD; i++) last = recordFailedLogin(k, new Date((t += 1000)));
        expect(last!.locked).not.toBeNull();
        pauses.push(last!.locked!.retryAfterSeconds);
        expect(lockoutStatus(k, new Date(t))).not.toBeNull();
        t += last!.locked!.retryAfterSeconds * 1000;
        expect(lockoutStatus(k, new Date(t))).toBeNull();
      }
      expect(pauses).toEqual([60, 120, 240, 480, 900, 900, 900]);
      expect(LOCKOUT_MAX_MS).toBe(900_000);
    });

    it('forgets failures outside the window, and the backoff after a quiet day', () => {
      const k = key();
      let t = Date.parse('2026-01-01T00:00:00Z');
      for (let i = 0; i < FAILED_LOGIN_THRESHOLD - 1; i++) recordFailedLogin(k, new Date((t += 1000)));
      t += FAILED_LOGIN_WINDOW_MS;
      expect(recordFailedLogin(k, new Date(t)).failures).toBe(1);

      for (let i = 0; i < FAILED_LOGIN_THRESHOLD - 2; i++) recordFailedLogin(k, new Date((t += 1000)));
      expect(recordFailedLogin(k, new Date(t)).locked?.lockouts).toBe(1);
      t += LOCKOUT_RESET_MS;
      for (let i = 0; i < FAILED_LOGIN_THRESHOLD - 1; i++) recordFailedLogin(k, new Date((t += 1000)));
      // Back to the shortest pause
      expect(recordFailedLogin(k, new Date(t)).locked).toMatchObject({ retryAfterSeconds: 60, lockouts: 1 });
    });

    it('prunes rows that can no longer lock anything', () => {
      const k = key();
      const then = new Date('2020-01-01T00:00:00Z');
      recordFailedLogin(k, then);
      expect(pruneLoginFailures(new Date(then.getTime() + LOCKOUT_RESET_MS - 1))).toBe(0);
      expect(pruneLoginFailures(new Date(then.getTime() + LOCKOUT_RESET_MS + 1))).toBeGreaterThanOrEqual(1);
      expect(getDb().select().from(loginFailures).where(eq(loginFailures.accountKey, k)).get()).toBeUndefined();
    });
  });

  describe('recordSignInDevice', () => {
    function seed() {
      const id = nanoid();
      getDb().insert(users).values({ id, email: `${id}@t.test`, displayName: 'T' }).run();
      return id;
    }

    it('reports a device as new only once, and not for the first one', () => {
      const userId = seed();
      expect(recordSignInDevice(userId, '198.51.100.1', 'curl/8').isNew).toBe(false);
      expect(recordSignInDevice(userId, '198.51.100.2', 'curl/8').isNew).toBe(false);
      expect(recordSignInDevice(userId, '192.0.2.1', 'curl/8').isNew).toBe(true);
      expect(recordSignInDevice(userId, '192.0.2.1', 'curl/8').isNew).toBe(false);
    });

    it('drops devices not used for months', () => {
      const userId = seed();
      recordSignInDevice(userId, '198.51.100.1', 'curl/8', undefined, new Date('2020-01-01T00:00:00Z'));
      expect(pruneStaleDevices(new Date('2021-01-01T00:00:00Z'))).toBeGreaterThanOrEqual(1);
      expect(getDb().select().from(userDevices).where(eq(userDevices.userId, userId)).all()).toHaveLength(0);
    });
  });
});
