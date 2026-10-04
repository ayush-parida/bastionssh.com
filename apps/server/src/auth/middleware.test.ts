import { describe, it, expect } from 'vitest';
import { rank, ROLES, type Role } from './middleware.js';

/**
 * Base roles survive only as names: SSO group mappings and the compatible
 * `role` fields old API callers read. No route gates on them any more
 * (`requireModule`, resource checks; the route sweep in
 * api/routes/route-sweep.test.ts proves it).
 */
describe('base role order', () => {
  it('orders roles least- to most-privileged', () => {
    expect(ROLES).toEqual(['viewer', 'operator', 'admin', 'owner']);
    expect(ROLES.map(rank)).toEqual([0, 1, 2, 3]);
  });

  it('treats an unrecognized role as least privileged', () => {
    expect(rank('superuser' as Role)).toBe(0);
  });
});
