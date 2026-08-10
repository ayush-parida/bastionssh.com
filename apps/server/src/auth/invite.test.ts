import { describe, it, expect } from 'vitest';
import {
  canGrantRole,
  emailsMatch,
  generateInviteToken,
  inviteExpiry,
  inviteState,
  maskEmail,
  wouldOrphanOrg,
} from './invite.js';

describe('canGrantRole', () => {
  it('lets an owner grant anything', () => {
    expect(canGrantRole('owner', 'owner')).toBe(true);
    expect(canGrantRole('owner', 'viewer')).toBe(true);
  });

  it('stops an admin minting an owner — the privilege-escalation path', () => {
    expect(canGrantRole('admin', 'owner')).toBe(false);
    expect(canGrantRole('admin', 'admin')).toBe(true);
    expect(canGrantRole('admin', 'operator')).toBe(true);
  });
});

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

describe('wouldOrphanOrg', () => {
  const members = [
    { userId: 'u1', role: 'owner' },
    { userId: 'u2', role: 'admin' },
  ];

  it('blocks demoting the only owner', () => {
    expect(wouldOrphanOrg(members, 'u1', 'admin')).toBe(true);
  });

  it('blocks removing the only owner', () => {
    expect(wouldOrphanOrg(members, 'u1', null)).toBe(true);
  });

  it('allows changing a non-owner', () => {
    expect(wouldOrphanOrg(members, 'u2', 'viewer')).toBe(false);
  });

  it('allows demoting one owner when another remains', () => {
    const two = [...members, { userId: 'u3', role: 'owner' }];
    expect(wouldOrphanOrg(two, 'u1', 'admin')).toBe(false);
  });

  it('treats an owner staying an owner as harmless', () => {
    expect(wouldOrphanOrg(members, 'u1', 'owner')).toBe(false);
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
