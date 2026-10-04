import { describe, it, expect } from 'vitest';
import { emailsMatch, generateInviteToken, inviteExpiry, inviteState, maskEmail } from './invite.js';

describe('inviteState', () => {
  const now = new Date('2026-01-10T00:00:00.000Z');

  it('is valid before expiry', () => {
    expect(inviteState({ expiresAt: '2026-01-11T00:00:00.000Z', acceptedAt: null }, now)).toBe('valid');
  });

  it('is expired at and after the deadline', () => {
    expect(inviteState({ expiresAt: '2026-01-10T00:00:00.000Z', acceptedAt: null }, now)).toBe('expired');
    expect(inviteState({ expiresAt: '2026-01-09T00:00:00.000Z', acceptedAt: null }, now)).toBe('expired');
  });

  it('reports an accepted invite even if it has not expired', () => {
    expect(
      inviteState({ expiresAt: '2026-01-11T00:00:00.000Z', acceptedAt: '2026-01-09T00:00:00.000Z' }, now),
    ).toBe('accepted');
  });

  it('issues expiry in the future', () => {
    expect(new Date(inviteExpiry(now)).getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('maskEmail', () => {
  it('shows enough to recognise, not enough to retype', () => {
    expect(maskEmail('dev@example.com')).toBe('de•@ex•••••.com');
  });

  it('never leaks the full local part or domain', () => {
    const masked = maskEmail('alice.smith@company.co');
    expect(masked).not.toContain('alice.smith');
    expect(masked).not.toContain('company');
    expect(masked.endsWith('.co')).toBe(true);
  });

  it('masks a single-character local part completely', () => {
    expect(maskEmail('a@b.com')).toBe('•@•.com');
  });

  it('survives an address with no dot in the domain', () => {
    expect(maskEmail('root@localhost')).toBe('ro••@lo•••••••');
  });
});

describe('emailsMatch', () => {
  it('ignores case and surrounding space', () => {
    expect(emailsMatch('  Dev@Example.COM ', 'dev@example.com')).toBe(true);
  });

  it('rejects a different address', () => {
    expect(emailsMatch('other@example.com', 'dev@example.com')).toBe(false);
  });

  it('does not treat a prefix as a match', () => {
    expect(emailsMatch('dev@example.co', 'dev@example.com')).toBe(false);
  });
});

describe('generateInviteToken', () => {
  it('is URL-safe and long enough to be unguessable', () => {
    const token = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateInviteToken()));
    expect(tokens.size).toBe(50);
  });
});
