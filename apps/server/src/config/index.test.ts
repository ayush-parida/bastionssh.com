import { describe, it, expect } from 'vitest';
import { DEV_ADMIN_PASSWORD, DEV_WEB_ORIGINS, parseTrustProxy, resolveAdminPassword, resolveWebauthn } from './index.js';

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

describe('resolveWebauthn', () => {
  const base = { rpName: 'BastionSSH' };

  it('defaults the RP ID and origin to SMT_BASE_URL', () => {
    expect(
      resolveWebauthn({ ...base, nodeEnv: 'production', baseUrl: 'https://ssh.example.com/app/' }),
    ).toEqual({ rpId: 'ssh.example.com', rpName: 'BastionSSH', origins: ['https://ssh.example.com'] });
  });

  it('also allows the Vite dev server in development', () => {
    const { rpId, origins } = resolveWebauthn({ ...base, nodeEnv: 'development', baseUrl: 'http://localhost:8080' });
    expect(rpId).toBe('localhost');
    expect(origins).toEqual(['http://localhost:8080', ...DEV_WEB_ORIGINS]);
  });

  it('uses explicit values as given', () => {
    expect(
      resolveWebauthn({
        ...base,
        nodeEnv: 'development',
        baseUrl: 'https://ssh.example.com',
        rpId: 'example.com',
        origins: 'https://ssh.example.com/, https://admin.example.com',
      }),
    ).toEqual({
      rpId: 'example.com',
      rpName: 'BastionSSH',
      origins: ['https://ssh.example.com', 'https://admin.example.com'],
    });
  });

  it('names a bad origin instead of failing with a bare "Invalid URL"', () => {
    for (const bad of ['ssh.example.com', 'not a url', 'mailto:x@example.com']) {
      expect(() =>
        resolveWebauthn({ ...base, nodeEnv: 'production', baseUrl: 'https://ssh.example.com', origins: `https://ok.example.com,${bad}` }),
      ).toThrow(`SMT_WEBAUTHN_ORIGINS: "${bad}" is not an origin`);
    }
  });
});
