import { describe, it, expect } from 'vitest';
import {
  bearerFrom,
  effectiveRole,
  generateApiToken,
  hashSecret,
  isExpired,
  parseApiToken,
  secretMatches,
} from './token.js';

describe('generateApiToken', () => {
  it('produces a parseable token whose hash matches its secret', () => {
    const { token, prefix, hashedToken } = generateApiToken();
    const parsed = parseApiToken(token);
    expect(parsed).not.toBeNull();
    expect(parsed!.prefix).toBe(prefix);
    expect(secretMatches(parsed!.secret, hashedToken)).toBe(true);
  });

  it('never stores the secret itself', () => {
    const { token, hashedToken, prefix } = generateApiToken();
    const secret = token.split('_')[2]!;
    expect(hashedToken).not.toContain(secret);
    expect(hashedToken).toHaveLength(64);
    expect(token.startsWith(`smt_${prefix}_`)).toBe(true);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateApiToken().token));
    expect(tokens.size).toBe(50);
  });

  it('round-trips every token, including secrets containing the separator', () => {
    // base64url includes '_', so roughly half of all secrets carry one
    for (let i = 0; i < 200; i++) {
      const { token, prefix, hashedToken } = generateApiToken();
      const parsed = parseApiToken(token);
      expect(parsed, token).not.toBeNull();
      expect(parsed!.prefix).toBe(prefix);
      expect(secretMatches(parsed!.secret, hashedToken)).toBe(true);
    }
  });
});

describe('parseApiToken', () => {
  it('rejects junk, wrong scheme, and truncated tokens', () => {
    expect(parseApiToken('nonsense')).toBeNull();
    expect(parseApiToken('ghp_abc_def')).toBeNull();
    expect(parseApiToken('smt_onlyprefix')).toBeNull();
    expect(parseApiToken('smt__secret')).toBeNull();
    expect(parseApiToken('')).toBeNull();
  });

  it('keeps underscores that belong to the secret', () => {
    expect(parseApiToken('smt_abc123_se_cr_et')).toEqual({
      prefix: 'abc123',
      secret: 'se_cr_et',
    });
  });
});

describe('secretMatches', () => {
  it('rejects a wrong secret', () => {
    const hash = hashSecret('the-real-secret');
    expect(secretMatches('not-the-secret', hash)).toBe(false);
    expect(secretMatches('the-real-secret', hash)).toBe(true);
  });

  it('rejects a malformed stored hash instead of throwing', () => {
    expect(secretMatches('anything', 'tooshort')).toBe(false);
  });
});

describe('isExpired', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('treats a null expiry as never expiring', () => {
    expect(isExpired(null, now)).toBe(false);
  });

  it('expires at and after the deadline', () => {
    expect(isExpired('2026-06-01T00:00:00.000Z', now)).toBe(true);
    expect(isExpired('2026-05-31T23:59:59.000Z', now)).toBe(true);
    expect(isExpired('2026-06-02T00:00:00.000Z', now)).toBe(false);
  });
});

describe('effectiveRole', () => {
  it('caps a read-only token at viewer regardless of the owner', () => {
    expect(effectiveRole('owner', ['read'])).toBe('viewer');
    expect(effectiveRole('admin', [])).toBe('viewer');
  });

  it('grants the owner’s role to a write token, never more', () => {
    expect(effectiveRole('operator', ['read', 'write'])).toBe('operator');
    expect(effectiveRole('owner', ['write'])).toBe('owner');
    expect(effectiveRole('viewer', ['write'])).toBe('viewer');
  });
});

describe('bearerFrom', () => {
  it('extracts the token and tolerates casing and spacing', () => {
    expect(bearerFrom('Bearer abc123')).toBe('abc123');
    expect(bearerFrom('bearer   abc123  ')).toBe('abc123');
  });

  it('ignores other schemes and empty headers', () => {
    expect(bearerFrom('Basic abc123')).toBeNull();
    expect(bearerFrom(undefined)).toBeNull();
    expect(bearerFrom('Bearer ')).toBeNull();
  });
});
