import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Revoking access must also end what is already open: terminals, pooled SFTP
 * and Docker connections (and Docker streams), and AI agent streams. The
 * closers are spied on here; their own behaviour is covered in
 * ssh/broker.test.ts, ssh/sftp-pool.test.ts, docker/pool.test.ts,
 * api/routes/docker.test.ts and ai/streams.test.ts.
 */
const closers = vi.hoisted(() => ({
  terminals: vi.fn(() => 0),
  sftp: vi.fn(() => 0),
  docker: vi.fn(() => 0),
  agents: vi.fn(() => 0),
}));

vi.mock('../../ssh/broker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ssh/broker.js')>();
  return { ...actual, SSHBroker: { ...actual.SSHBroker, closeForUser: closers.terminals } };
});
vi.mock('../../ssh/sftp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ssh/sftp.js')>();
  return { ...actual, evictUser: closers.sftp };
});
vi.mock('../../docker/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../docker/index.js')>();
  return { ...actual, closeDockerForUser: closers.docker };
});
vi.mock('../../ai/streams.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ai/streams.js')>();
  return { ...actual, abortAgentStreams: closers.agents };
});

import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { seedOrg, seedServer, seedSession, seedUser } from './test-utils.js';

describe('live access revocation', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let serverA: string;

  const call = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: admin.headers, ...(payload && { payload }) });

  /** Every closer was called once for `userId` with this scope. */
  function expectRevoked(userId: string, scope: { orgId?: string; keepServerIds?: string[] }) {
    expect(closers.terminals).toHaveBeenCalledTimes(1);
    expect(closers.terminals).toHaveBeenCalledWith(userId, {
      orgId: scope.orgId,
      keepServerIds: scope.keepServerIds,
    });
    expect(closers.sftp).toHaveBeenCalledWith(userId, { orgId: scope.orgId, keepServerIds: scope.keepServerIds });
    expect(closers.docker).toHaveBeenCalledWith(userId, { orgId: scope.orgId, keepServerIds: scope.keepServerIds });
    expect(closers.agents).toHaveBeenCalledWith(userId, { orgId: scope.orgId });
  }

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-live-revoke');
    admin = seedUser(orgId, 'admin');
    seedUser(orgId, 'owner');
    serverA = seedServer(orgId, admin.userId, 'alpha');
    seedServer(orgId, admin.userId, 'bravo');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes everything in the org on suspension', async () => {
    const member = seedUser(orgId, 'operator');
    expect((await call('POST', `/api/team/members/${member.userId}/suspend`)).statusCode).toBe(200);
    expectRevoked(member.userId, { orgId });
  });

  it('closes everything in the org on removal', async () => {
    const member = seedUser(orgId, 'operator');
    expect((await call('DELETE', `/api/team/members/${member.userId}`)).statusCode).toBe(204);
    expectRevoked(member.userId, { orgId });
  });

  it('closes what is open on servers no longer granted when access is narrowed', async () => {
    const member = seedUser(orgId, 'operator');
    const res = await call('PUT', `/api/team/members/${member.userId}/access`, {
      serverAccess: 'restricted',
      serverIds: [serverA],
    });
    expect(res.statusCode).toBe(200);
    expectRevoked(member.userId, { orgId, keepServerIds: [serverA] });
  });

  it('closes nothing when access is widened to every server', async () => {
    const member = seedUser(orgId, 'operator');
    const res = await call('PUT', `/api/team/members/${member.userId}/access`, { serverAccess: 'all' });
    expect(res.statusCode).toBe(200);
    expect(closers.terminals).not.toHaveBeenCalled();
    expect(closers.agents).not.toHaveBeenCalled();
  });

  it('closes everything, in every org, on sign-out-everywhere', async () => {
    const member = seedUser(orgId, 'viewer');
    expect((await call('DELETE', `/api/team/members/${member.userId}/sessions`)).statusCode).toBe(200);
    expectRevoked(member.userId, {});
  });

  it('closes everything, in every org, when a password reset is used', async () => {
    const member = seedUser(orgId, 'viewer');
    // Issuing needs a signed-in browser, not the admin's API token
    const { link } = (
      await app.inject({
        method: 'POST',
        url: `/api/team/members/${member.userId}/password-reset`,
        headers: (await seedSession(admin.userId)).headers,
      })
    ).json();
    vi.clearAllMocks();
    const res = await app.inject({
      method: 'POST',
      url: `/api/password-reset/${link.split('/reset-password/')[1]}`,
      payload: { password: 'brand-new-password' },
    });
    expect(res.statusCode).toBe(200);
    expectRevoked(member.userId, {});
  });

  it('does not close anything when the action is refused', async () => {
    const peer = seedUser(orgId, 'admin');
    expect((await call('POST', `/api/team/members/${peer.userId}/suspend`)).statusCode).toBe(403);
    expect(closers.terminals).not.toHaveBeenCalled();
  });
});
