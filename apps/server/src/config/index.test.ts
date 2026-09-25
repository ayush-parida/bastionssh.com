import { describe, it, expect } from 'vitest';
import { DEV_ADMIN_PASSWORD, parseTrustProxy, resolveAdminPassword } from './index.js';

describe('resolveAdminPassword', () => {
  it('falls back to the dev password when NODE_ENV is explicitly development or test', () => {
    expect(resolveAdminPassword('development', undefined)).toBe(DEV_ADMIN_PASSWORD);
    expect(resolveAdminPassword('test', undefined)).toBe(DEV_ADMIN_PASSWORD);
    expect(resolveAdminPassword('development', 'my-own-pass')).toBe('my-own-pass');
  });

  it('treats an unset NODE_ENV like production', () => {
    expect(resolveAdminPassword(undefined, undefined)).toBeNull();
    expect(resolveAdminPassword(undefined, DEV_ADMIN_PASSWORD)).toBeNull();
    expect(resolveAdminPassword(undefined, 'correct-horse-battery')).toBe('correct-horse-battery');
  });

  it('asks for a generated password in production when unset or the published default', () => {
    expect(resolveAdminPassword('production', undefined)).toBeNull();
    expect(resolveAdminPassword('production', DEV_ADMIN_PASSWORD)).toBeNull();
  });

  it('keeps an operator-chosen password in production', () => {
    expect(resolveAdminPassword('production', 'correct-horse-battery')).toBe('correct-horse-battery');
  });
});

describe('parseTrustProxy', () => {
  it('trusts no proxy by default', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('accepts true, a hop count, or an address list', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy(' 10.0.0.0/8,127.0.0.1 ')).toBe('10.0.0.0/8,127.0.0.1');
  });
});
