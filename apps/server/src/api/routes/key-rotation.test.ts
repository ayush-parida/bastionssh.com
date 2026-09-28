import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A fake fleet: each server is a throwaway $HOME. A "connection" succeeds only
 * when the login key's blob is listed in that home's authorized_keys (as sshd
 * would decide), then runs the command under the local /bin/sh. `intercept`
 * lets a test fail or alter one call. State lives in a hoisted object and the
 * mock is a plain function (see vitest-mock-class-fields).
 */
type Kind = 'install' | 'remove' | 'verify';
interface Call {
  serverId: string;
  kind: Kind;
  loginBlob: string;
  command: string;
}
interface Result {
  stdout: string;
  stderr: string;
  exitCode: number;
}
const fake = vi.hoisted(() => ({
  homes: new Map<string, string>(),
  calls: [] as Call[],
  intercept: null as null | ((call: Call, home: string) => Result | void | Promise<Result | void>),
}));

vi.mock('../../ssh/broker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ssh/broker.js')>();
  return {
    ...actual,
    execOnServer: (target: { id: string }, auth: { privateKey?: string }, command: string, _t: number, stdin?: string) =>
      fakeExec(target, auth, command, stdin),
  };
});

const ssh2 = (await import('ssh2')).default;
const { eq, and } = await import('drizzle-orm');
const { nanoid } = await import('nanoid');
const { buildApp } = await import('../app.js');
const { runMigrations } = await import('../../db/migrate.js');
const { getDb } = await import('../../db/index.js');
const { auditLog, cloudAccounts, keyRotations, memberServerAccess, memberships, passkeys, servers, sshKeys } =
  await import('../../db/schema.js');
const { vault } = await import('../../vault/index.js');
const { resolveServerAuth } = await import('../../ssh/credentials.js');
const scripts = await import('../../ssh/key-rotation.js');
const { markInterruptedRotations } = scripts;
const { seedOrg, seedServer, seedUser } = await import('./test-utils.js');

function blobOfPrivate(pem: string): string {
  const parsed = ssh2.utils.parseKey(pem);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('bad key');
  return parsed.getPublicSSH().toString('base64');
}

function listed(home: string, blob: string): boolean {
  const file = path.join(home, '.ssh', 'authorized_keys');
  if (!fs.existsSync(file)) return false;
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .some((line) => !line.trim().startsWith('#') && line.trim().split(/\s+/).includes(blob));
}

async function fakeExec(target: { id: string }, auth: { privateKey?: string }, command: string, stdin?: string): Promise<Result> {
  const home = fake.homes.get(target.id);
  if (!home) throw new Error('connect ECONNREFUSED');
  const kind: Kind = stdin?.includes('echo added') ? 'install' : stdin?.includes('echo removed') ? 'remove' : 'verify';
  const call = { serverId: target.id, kind, loginBlob: blobOfPrivate(auth.privateKey!), command };
  fake.calls.push(call);
  const override = await fake.intercept?.(call, home);
  if (override) return override;
  if (!listed(home, call.loginBlob)) {
    throw Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' });
  }
  const r = spawnSync('sh', ['-c', command], { input: stdin, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
}

const OTHER_LINE = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDBzrp2STH2pmmNlq1rKViosIU1Jn76TBXiFnLSIpPseBjWjL39HNto alice@laptop';

describe('SSH key rotation', { timeout: 30_000 }, () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let owner: ReturnType<typeof seedUser>;
  let admin: ReturnType<typeof seedUser>;
  let operator: ReturnType<typeof seedUser>;
  let restricted: ReturnType<typeof seedUser>;
  let foreignAdmin: ReturnType<typeof seedUser>;
  const tmpRoots: string[] = [];

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-rotation');
    owner = seedUser(orgId, 'owner');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    restricted = seedUser(orgId, 'operator');
    getDb()
      .update(memberships)
      .set({ serverAccess: 'restricted' })
      .where(and(eq(memberships.userId, restricted.userId), eq(memberships.orgId, orgId)))
      .run();
    foreignAdmin = seedUser(seedOrg('org-rotation-b'), 'owner');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fake.calls = [];
    fake.intercept = null;
  });

  const db = () => getDb();

  async function seedKey(name = 'deploy') {
    const pair = ssh2.utils.generateKeyPairSync('ed25519');
    const id = nanoid();
    db()
      .insert(sshKeys)
      .values({
        id,
        orgId,
        name,
        type: 'ed25519',
        publicKey: pair.public,
        fingerprint: `SHA256:${id}`,
        encryptedPrivateKey: await vault.encrypt(pair.private, id),
        createdBy: owner.userId,
      })
      .run();
    return { id, blob: blobOfPrivate(pair.private), line: `${pair.public.trim()} deploy@bastion` };
  }

  /** A key-auth server whose home lists `lines`; the host is unique unless given. */
  function seedFleetServer(keyId: string, lines: string[], name = `srv-${nanoid(4)}`, host = `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`) {
    const id = seedServer(orgId, owner.userId, name);
    db().update(servers).set({ defaultKeyId: keyId, host }).where(eq(servers.id, id)).run();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-home-'));
    tmpRoots.push(home);
    fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
    const file = path.join(home, '.ssh', 'authorized_keys');
    fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
    fake.homes.set(id, home);
    return { id, home, file, read: () => fs.readFileSync(file, 'utf8') };
  }

  const serverRow = (id: string) => db().select().from(servers).where(eq(servers.id, id)).get()!;
  const keyRow = (id: string) => db().select().from(sshKeys).where(eq(sshKeys.id, id)).get();
  const audited = (action: string, resourceId: string) =>
    db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId)))
      .all();

  const rotate = (serverId: string, headers = admin.headers, payload: object = {}) =>
    app.inject({ method: 'POST', url: `/api/servers/${serverId}/rotate-key`, headers, payload });

  it('rotates: installs, verifies, switches, removes the old line and retires the old key', async () => {
    const old = await seedKey();
    const srv = seedFleetServer(old.id, ['# hand-kept comment', OTHER_LINE, old.line]);

    const res = await rotate(srv.id);
    expect(res.statusCode).toBe(200);
    const rotation = res.json();
    expect(rotation).toMatchObject({ status: 'completed', step: 'done', error: null, warnings: [], oldKeyRetired: true, oldKeyId: old.id });

    // The server is on the new key, which remembers what it replaced
    const newKeyId = serverRow(srv.id).defaultKeyId!;
    expect(newKeyId).toBe(rotation.newKeyId);
    expect(keyRow(newKeyId)).toMatchObject({ rotatedFromKeyId: old.id, retiredAt: null, type: 'ed25519' });
    expect(keyRow(old.id)!.retiredAt).not.toBeNull();

    // authorized_keys: the old line is gone, unrelated lines are untouched, the new one is tagged
    const newPublic = keyRow(newKeyId)!.publicKey.trim();
    expect(srv.read()).toBe(`# hand-kept comment\n${OTHER_LINE}\n${newPublic} bastionssh-key-${newKeyId}\n`);
    expect(fs.statSync(srv.file).mode & 0o777).toBe(0o600);

    // Install over the old key, verify and remove over the new one
    const newBlob = newPublic.split(' ')[1];
    expect(fake.calls.map((c) => [c.kind, c.loginBlob === old.blob ? 'old' : c.loginBlob === newBlob ? 'new' : '?'])).toEqual([
      ['install', 'old'],
      ['verify', 'new'],
      ['remove', 'new'],
    ]);

    expect(audited('ssh_key.rotate', srv.id)).toHaveLength(1);
    expect(audited('ssh_key.retire', old.id)).toHaveLength(1);
    const history = await app.inject({ method: 'GET', url: `/api/keys/rotations?serverId=${srv.id}`, headers: admin.headers });
    expect(history.json()).toEqual([expect.objectContaining({ id: rotation.id, status: 'completed' })]);

    // A retired key can neither be used nor assigned again
    await expect(resolveServerAuth(orgId, srv.id, old.id)).rejects.toMatchObject({ statusCode: 409 });
    const reassign = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${srv.id}`,
      headers: admin.headers,
      payload: { authType: 'key', defaultKeyId: old.id },
    });
    expect(reassign.statusCode).toBe(400);
    const keys = await app.inject({ method: 'GET', url: '/api/keys', headers: admin.headers });
    expect(keys.json().find((k: { id: string }) => k.id === old.id).retiredAt).not.toBeNull();
  });

  it('can switch to another key type', async () => {
    const old = await seedKey();
    const srv = seedFleetServer(old.id, [old.line]);
    const res = await rotate(srv.id, admin.headers, { type: 'ecdsa' });
    expect(res.json().status).toBe('completed');
    expect(keyRow(serverRow(srv.id).defaultKeyId!)!.type).toBe('ecdsa');
  });

  it('a failed verification keeps the old key and puts authorized_keys back byte for byte', async () => {
    const old = await seedKey();
    const srv = seedFleetServer(old.id, [OTHER_LINE, old.line]);
    const before = srv.read();
    const keysBefore = db().select().from(sshKeys).all().length;
    fake.intercept = (call) => {
      if (call.kind === 'verify') throw Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' });
    };

    const res = await rotate(srv.id);
    expect(res.json()).toMatchObject({ status: 'rolled_back', step: 'verify', newKeyId: null, oldKeyRetired: false });
    expect(res.json().error).toMatch(/authentication methods failed/);
    expect(serverRow(srv.id).defaultKeyId).toBe(old.id);
    expect(srv.read()).toBe(before);
    expect(keyRow(old.id)!.retiredAt).toBeNull();
    expect(db().select().from(sshKeys).all()).toHaveLength(keysBefore);
    // The rollback ran over the old key
    expect(fake.calls.at(-1)).toMatchObject({ kind: 'remove', loginBlob: old.blob });
    expect(audited('ssh_key.rotate_failed', srv.id)).toHaveLength(1);
    expect(audited('ssh_key.rotate', srv.id)).toHaveLength(0);
  });

  it('fails without touching anything when the current key is not in ~/.ssh/authorized_keys', async () => {
    const old = await seedKey();
    // Logs in (e.g. via AuthorizedKeysFile elsewhere) but is not in the file we edit
    const srv = seedFleetServer(old.id, [OTHER_LINE]);
    const before = srv.read();
    // Accept the old key although it is not listed
    fake.intercept = (call, home) => {
      if (call.loginBlob !== old.blob) return;
      const r = spawnSync('sh', ['-c', call.command], { input: scripts.INSTALL_SCRIPT, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
    };

    const res = await rotate(srv.id);
    expect(res.json()).toMatchObject({ status: 'failed', step: 'install' });
    expect(res.json().error).toMatch(/current key is not listed/);
    expect(srv.read()).toBe(before);
    expect(serverRow(srv.id).defaultKeyId).toBe(old.id);
    // Nothing to undo, so no rollback connection
    expect(fake.calls.map((c) => c.kind)).toEqual(['install']);
  });

  it('fails cleanly when the old key cannot log in at all', async () => {
    const old = await seedKey();
    const srv = seedFleetServer(old.id, [OTHER_LINE]);
    const res = await rotate(srv.id);
    expect(res.json()).toMatchObject({ status: 'failed', step: 'install', warnings: [] });
    expect(fake.calls).toHaveLength(1);
  });

  it('goes back to the old key when removing it fails but the old key still works', async () => {
    const old = await seedKey();
    const srv = seedFleetServer(old.id, [OTHER_LINE, old.line]);
    const before = srv.read();
    fake.intercept = (call) => {
      if (call.kind === 'remove' && call.loginBlob !== old.blob) {
        return { stdout: '', stderr: 'mv: cannot move: Read-only file system', exitCode: 5 };
      }
    };

    const res = await rotate(srv.id);
    expect(res.json()).toMatchObject({ status: 'rolled_back', step: 'remove_old', newKeyId: null, oldKeyRetired: false });
    expect(res.json().error).toMatch(/Read-only file system/);
    expect(serverRow(srv.id).defaultKeyId).toBe(old.id);
    expect(srv.read()).toBe(before);
    // The saved new key is deleted again
    expect(db().select().from(sshKeys).where(eq(sshKeys.rotatedFromKeyId, old.id)).all()).toHaveLength(0);
    expect(keyRow(old.id)!.retiredAt).toBeNull();
  });

  it('keeps the new key when the old key was removed but the reply was lost', async () => {
    const old = await seedKey();
    const srv = seedFleetServer(old.id, [OTHER_LINE, old.line]);
    fake.intercept = (call, home) => {
      if (call.kind === 'remove' && call.loginBlob !== old.blob) {
        // The edit happens on the server, then the connection drops
        spawnSync('sh', ['-c', call.command], { input: scripts.REMOVE_SCRIPT, env: { PATH: process.env.PATH, HOME: home } });
        throw new Error('Connection lost before handshake');
      }
    };

    const res = await rotate(srv.id);
    const rotation = res.json();
    expect(rotation).toMatchObject({ status: 'completed', step: 'remove_old', oldKeyRetired: false });
    expect(rotation.newKeyId).toBe(serverRow(srv.id).defaultKeyId);
    expect(rotation.warnings.join(' ')).toMatch(/Kept the new key/);
    // The server still accepts the key it is configured with
    const newBlob = keyRow(rotation.newKeyId)!.publicKey.trim().split(' ')[1]!;
    expect(listed(srv.home, newBlob)).toBe(true);
    expect(listed(srv.home, old.blob)).toBe(false);
    expect(srv.read()).toContain(OTHER_LINE);
  });

  it('rolls back when the server is reassigned mid-rotation', async () => {
    const old = await seedKey();
    const other = await seedKey('other');
    const srv = seedFleetServer(old.id, [old.line]);
    const before = srv.read();
    fake.intercept = (call) => {
      if (call.kind === 'verify') db().update(servers).set({ defaultKeyId: other.id }).where(eq(servers.id, srv.id)).run();
    };

    const res = await rotate(srv.id);
    expect(res.json()).toMatchObject({ status: 'rolled_back', step: 'switch' });
    expect(serverRow(srv.id).defaultKeyId).toBe(other.id);
    expect(srv.read()).toBe(before);
    expect(db().select().from(sshKeys).where(eq(sshKeys.rotatedFromKeyId, old.id)).all()).toHaveLength(0);
  });

  it('leaves the old line for other servers on the same account, and retires only when the last server moves', async () => {
    const old = await seedKey();
    const a = seedFleetServer(old.id, [old.line], 'shared-a', '10.9.9.9');
    const b = seedFleetServer(old.id, [old.line], 'shared-b', '10.9.9.9');
    // Same account: both rows reach one authorized_keys
    fake.homes.set(b.id, a.home);

    const first = (await rotate(a.id)).json();
    expect(first).toMatchObject({ status: 'completed', oldKeyRetired: false });
    expect(first.warnings.join(' ')).toMatch(/shared-b log in to the same account/);
    expect(listed(a.home, old.blob)).toBe(true);
    expect(keyRow(old.id)!.retiredAt).toBeNull();

    const second = (await rotate(b.id)).json();
    expect(second).toMatchObject({ status: 'completed', oldKeyRetired: true, warnings: [] });
    expect(listed(a.home, old.blob)).toBe(false);
    // Each server got its own key, both still listed
    const keyA = keyRow(serverRow(a.id).defaultKeyId!)!;
    const keyB = keyRow(serverRow(b.id).defaultKeyId!)!;
    expect(keyA.id).not.toBe(keyB.id);
    expect(listed(a.home, keyA.publicKey.split(' ')[1]!)).toBe(true);
    expect(listed(a.home, keyB.publicKey.split(' ')[1]!)).toBe(true);
  });

  it('does not retire a key a cloud account still assigns', async () => {
    const old = await seedKey();
    const srv = seedFleetServer(old.id, [old.line]);
    db()
      .insert(cloudAccounts)
      .values({
        id: nanoid(),
        orgId,
        name: 'aws-prod',
        provider: 'aws',
        encryptedCredentials: 'x',
        credentialHint: 'AKIA…',
        defaultKeyId: old.id,
        createdBy: owner.userId,
      })
      .run();
    const res = (await rotate(srv.id)).json();
    expect(res).toMatchObject({ status: 'completed', oldKeyRetired: false });
    expect(res.warnings.join(' ')).toMatch(/aws-prod/);
    expect(keyRow(old.id)!.retiredAt).toBeNull();
  });

  it('bulk-rotates selected servers in the background, one record each', async () => {
    const old = await seedKey();
    const s1 = seedFleetServer(old.id, [OTHER_LINE, old.line]);
    const s2 = seedFleetServer(old.id, [old.line]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/keys/rotate',
      headers: admin.headers,
      payload: { serverIds: [s1.id, s2.id, s1.id] },
    });
    expect(res.statusCode).toBe(202);
    const { batchId, rotations } = res.json();
    expect(rotations).toHaveLength(2);
    expect(rotations.every((r: { status: string }) => r.status === 'pending')).toBe(true);
    expect(audited('ssh_key.rotate_bulk', batchId)).toHaveLength(1);

    await vi.waitFor(
      async () => {
        const list = (await app.inject({ method: 'GET', url: `/api/keys/rotations?batchId=${batchId}`, headers: admin.headers })).json();
        expect(list.map((r: { status: string }) => r.status)).toEqual(['completed', 'completed']);
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(keyRow(old.id)!.retiredAt).not.toBeNull();
    expect(listed(s1.home, old.blob)).toBe(false);
    expect(listed(s2.home, old.blob)).toBe(false);
  });

  it('refuses a bulk request that includes a server it cannot rotate, queuing nothing', async () => {
    const old = await seedKey();
    const ok = seedFleetServer(old.id, [old.line]);
    const pw = seedServer(orgId, owner.userId, 'pw-server');
    db().update(servers).set({ encryptedPassword: 'enc' }).where(eq(servers.id, pw)).run();
    const res = await app.inject({ method: 'POST', url: '/api/keys/rotate', headers: admin.headers, payload: { serverIds: [ok.id, pw] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/pw-server uses password authentication/);
    expect(db().select().from(keyRotations).where(eq(keyRotations.serverId, ok.id)).all()).toHaveLength(0);
  });

  it('refuses a second rotation while one is queued', async () => {
    const old = await seedKey();
    const srv = seedFleetServer(old.id, [old.line]);
    db()
      .insert(keyRotations)
      .values({ id: nanoid(), orgId, serverId: srv.id, serverName: 'x', oldKeyId: old.id, oldFingerprint: 'fp', status: 'pending', startedBy: admin.userId })
      .run();
    expect((await rotate(srv.id)).statusCode).toBe(409);
    // A restart turns it into an interrupted record, after which rotation is allowed again
    expect(markInterruptedRotations()).toBeGreaterThanOrEqual(1);
    expect((await rotate(srv.id)).json().status).toBe('completed');
  });

  it('is admin-only, needs a passkey step-up when the admin has one, and hides other orgs', async () => {
    const old = await seedKey();
    const srv = seedFleetServer(old.id, [old.line]);
    expect((await rotate(srv.id, operator.headers)).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/keys/rotate', headers: operator.headers, payload: { serverIds: [srv.id] } })).statusCode).toBe(403);
    expect((await rotate(srv.id, foreignAdmin.headers)).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/api/keys/rotate', headers: foreignAdmin.headers, payload: { serverIds: [srv.id] } })).statusCode,
    ).toBe(404);

    const stepper = seedUser(orgId, 'admin');
    db()
      .insert(passkeys)
      .values({ id: nanoid(), userId: stepper.userId, credentialId: nanoid(), publicKey: Buffer.from('x'), deviceType: 'singleDevice', name: 'yubikey' })
      .run();
    const res = await rotate(srv.id, stepper.headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('PASSKEY_STEP_UP_REQUIRED');
    expect(fake.calls).toHaveLength(0);
    expect(serverRow(srv.id).defaultKeyId).toBe(old.id);
  });

  it('refuses a password server', async () => {
    const pw = seedServer(orgId, owner.userId, 'pw-only');
    db().update(servers).set({ encryptedPassword: 'enc' }).where(eq(servers.id, pw)).run();
    const res = await rotate(pw);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/password authentication/);
  });

  it('shows restricted members only the history of servers they were granted', async () => {
    const old = await seedKey();
    const granted = seedFleetServer(old.id, [old.line]);
    const hidden = seedFleetServer(old.id, [old.line]);
    await rotate(granted.id);
    await rotate(hidden.id);
    db().insert(memberServerAccess).values({ orgId, userId: restricted.userId, serverId: granted.id }).run();

    const list = (await app.inject({ method: 'GET', url: `/api/keys/rotations?keyId=${old.id}`, headers: restricted.headers })).json();
    expect(list.map((r: { serverId: string }) => r.serverId)).toEqual([granted.id]);
    const all = (await app.inject({ method: 'GET', url: `/api/keys/rotations?keyId=${old.id}`, headers: admin.headers })).json();
    expect(all).toHaveLength(2);
    const foreign = (await app.inject({ method: 'GET', url: '/api/keys/rotations', headers: foreignAdmin.headers })).json();
    expect(foreign).toEqual([]);
  });
});
