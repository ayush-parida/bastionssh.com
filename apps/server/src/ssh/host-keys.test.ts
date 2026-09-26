import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { and, eq } from 'drizzle-orm';

// Fake ssh2 Client for scanHostKey: connect() runs the verifier on the key in
// `state.presented`, then fails the handshake the way ssh2 does on refusal.
// Methods only, state in a closure (see vitest-mock-class-fields).
vi.mock('ssh2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ssh2')>();
  const { EventEmitter } = await import('node:events');
  const state = { presented: Buffer.alloc(0), configs: [] as any[] };
  class Client extends EventEmitter {
    connect(cfg: any) {
      state.configs.push(cfg);
      setImmediate(() => {
        if (cfg.hostVerifier(state.presented) === false) {
          this.emit('error', new Error('Host denied (verification failed)'));
          this.emit('close');
        } else {
          this.emit('ready');
        }
      });
      return this;
    }
    end() {}
  }
  // ssh2 is CommonJS: its utils live on the default export
  const utils = (actual as any).utils ?? (actual as any).default?.utils;
  return { ...actual, utils, Client, __state: state };
});

const ssh2 = (await import('ssh2')) as any;
const state = ssh2.__state as { presented: Buffer; configs: any[] };
const { runMigrations } = await import('../db/migrate.js');
const { getDb } = await import('../db/index.js');
const { auditLog, serverAlerts, servers } = await import('../db/schema.js');
const { seedOrg, seedUser, seedServer } = await import('../api/routes/test-utils.js');
const hk = await import('./host-keys.js');

/** SSH wire `string`: uint32 length + bytes. */
function sshString(data: Buffer | string) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

/** A fresh ed25519 host key blob built from node:crypto, independent of ssh2. */
function ed25519Blob() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.concat([sshString('ssh-ed25519'), sshString(der.subarray(der.length - 32))]);
}

// Generated with ssh-keygen; fingerprints are its `ssh-keygen -lf` output.
const ED25519_LINE =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElIFDlvr3BbqwqJML2vALk7zEJk8g6g/KL13zhz+dh8';
const ED25519_FP = 'SHA256:7RzRboFL75PCBozdMj7VbF+Y5sel8sTZxSqUkmATKNk';
const RSA_LINE =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDBzrp2STH2pmmNlq1rKViosIU1Jn76TBXiFnLSIpPseBjWjL39HNtoWHk8WMGC4dkqftSt4H56RUCtWNflzAoZau9xNp5x0X3m36igPHLTqLU369J9MaNPx8Fl9V9uX5MZg5sYUQPlm/39pR6lbrN3kSvbmMUPTBjsDCnzMm07DOG8cUcPgP6ozDjDG97WmWoaCjnNbY1naclVjaYvRDGqxxheg0ZOXukugTAPj/bfzTtUA8WrQ2jwSknnI2j3I8+0fKcNlJlwUO/samY+A4D6DaUgQw28dlrRcQL9X9Z02+rzObOA9zx0OogotKH2lZsSeuPsq9UuB0nLeAbksrMx';
const RSA_FP = 'SHA256:S7Axguai+B29/IGiF9tcSRxdklcSxD2vNoSLuUdBD8U';

const blobOf = (line: string) => Buffer.from(line.split(' ')[1]!, 'base64');

describe('host key fingerprints', () => {
  it('match ssh-keygen -lf for a known ed25519 and rsa key', () => {
    expect(hk.hostKeyFingerprint(blobOf(ED25519_LINE))).toBe(ED25519_FP);
    expect(hk.hostKeyFingerprint(blobOf(RSA_LINE))).toBe(RSA_FP);
    expect(hk.hostKeyType(blobOf(ED25519_LINE))).toBe('ssh-ed25519');
    expect(hk.hostKeyType(blobOf(RSA_LINE))).toBe('ssh-rsa');
  });

  it('hashes the raw blob (hand-computed sha256, unpadded base64) and agrees with ssh2', () => {
    const blob = ed25519Blob();
    const expected =
      'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
    expect(hk.hostKeyFingerprint(blob)).toBe(expected);
    expect(hk.hostKeyFingerprint(blob)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);

    // ssh2's own parser sees the same key and type
    const parsed = ssh2.utils.parseKey(`ssh-ed25519 ${blob.toString('base64')}`);
    expect(parsed.type).toBe('ssh-ed25519');
    expect(Buffer.compare(parsed.getPublicSSH(), blob)).toBe(0);

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsa = ssh2.utils.parseKey(privateKey.export({ type: 'pkcs1', format: 'pem' }));
    const rsaBlob: Buffer = rsa.getPublicSSH();
    expect(hk.hostKeyType(rsaBlob)).toBe('ssh-rsa');
    expect(hk.hostKeyFingerprint(rsaBlob)).toBe(
      'SHA256:' + createHash('sha256').update(rsaBlob).digest('base64').replace(/=+$/, ''),
    );
  });

  it('validates the fingerprint format', () => {
    expect(hk.isValidFingerprint(ED25519_FP)).toBe(true);
    expect(hk.isValidFingerprint(ED25519_FP.slice(0, -1))).toBe(false);
    expect(hk.isValidFingerprint(`${ED25519_FP}=`)).toBe(false);
    expect(hk.isValidFingerprint(ED25519_FP.replace('SHA256:', 'MD5:'))).toBe(false);
    expect(hk.hostKeyType(Buffer.from([0, 0]))).toBeNull();
  });
});

describe('checkHostKey', () => {
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('hostkeys');
    userId = seedUser(orgId, 'admin').userId;
  });

  const row = (id: string) => getDb().select().from(servers).where(eq(servers.id, id)).get()!;
  const auditFor = (id: string, action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceId, id), eq(auditLog.action, action)))
      .all();
  const alertsFor = (id: string) =>
    getDb().select().from(serverAlerts).where(eq(serverAlerts.serverId, id)).all();

  it('trusts on first use: records the key and audits it as the system', () => {
    const id = seedServer(orgId, userId);
    const blob = blobOf(ED25519_LINE);

    expect(hk.checkHostKey(id, blob, 'terminal')).toEqual({ ok: true });

    const r = row(id);
    expect(r.hostKeyFingerprint).toBe(ED25519_FP);
    expect(r.hostKeyType).toBe('ssh-ed25519');
    expect(r.hostKeyTrustedAt).toBeTruthy();
    expect(r.hostKeyTrustedBy).toBeNull();
    expect(hk.hostKeyStatus(r)).toBe('trusted');

    const [entry] = auditFor(id, 'server.host_key_trusted');
    expect(entry).toMatchObject({ actorId: 'system', actorEmail: 'system', orgId });
    expect(JSON.parse(entry!.metadata!)).toMatchObject({
      method: 'tofu',
      fingerprint: ED25519_FP,
      type: 'ssh-ed25519',
      via: 'terminal',
    });
  });

  it('accepts the pinned key without re-auditing, and fills in a missing type', () => {
    const id = seedServer(orgId, userId);
    getDb()
      .update(servers)
      .set(hk.pinnedColumns(RSA_FP, null, userId))
      .where(eq(servers.id, id))
      .run();

    expect(hk.checkHostKey(id, blobOf(RSA_LINE), 'exec')).toEqual({ ok: true });
    expect(row(id).hostKeyType).toBe('ssh-rsa');
    expect(row(id).hostKeyTrustedBy).toBe(userId);
    expect(auditFor(id, 'server.host_key_trusted')).toHaveLength(0);
  });

  it('refuses a different key: records it once, audits, alerts, and throws a typed error', () => {
    const id = seedServer(orgId, userId);
    hk.checkHostKey(id, blobOf(ED25519_LINE), 'terminal');

    const result = hk.checkHostKey(id, blobOf(RSA_LINE), 'sftp');
    expect(result.ok).toBe(false);
    const err = (result as { error: Error }).error;
    expect(err).toBeInstanceOf(hk.HostKeyMismatchError);
    expect(err).toMatchObject({ expected: ED25519_FP, presented: RSA_FP, statusCode: 409 });
    expect((err as InstanceType<typeof hk.HostKeyMismatchError>).toJSON()).toMatchObject({
      code: 'HOST_KEY_MISMATCH',
      expected: ED25519_FP,
      presented: RSA_FP,
    });

    const r = row(id);
    // The pinned key is untouched
    expect(r.hostKeyFingerprint).toBe(ED25519_FP);
    expect(r.hostKeyMismatchFingerprint).toBe(RSA_FP);
    expect(r.hostKeyMismatchType).toBe('ssh-rsa');
    expect(r.hostKeyMismatchAt).toBeTruthy();
    expect(hk.hostKeyStatus(r)).toBe('mismatch');

    const [entry] = auditFor(id, 'server.host_key_mismatch');
    expect(JSON.parse(entry!.metadata!)).toMatchObject({ expected: ED25519_FP, presented: RSA_FP, via: 'sftp' });
    const alerts = alertsFor(id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'host_key_mismatch', severity: 'critical', resolvedAt: null });

    // The same wrong key again: refused, but no second audit row or alert
    const firstSeenAt = r.hostKeyMismatchAt;
    expect(hk.checkHostKey(id, blobOf(RSA_LINE), 'exec').ok).toBe(false);
    expect(auditFor(id, 'server.host_key_mismatch')).toHaveLength(1);
    expect(alertsFor(id)).toHaveLength(1);
    expect(row(id).hostKeyMismatchAt).toBe(firstSeenAt);

    // A third, different key is new evidence and is recorded
    const other = ed25519Blob();
    expect(hk.checkHostKey(id, other, 'exec').ok).toBe(false);
    expect(row(id).hostKeyMismatchFingerprint).toBe(hk.hostKeyFingerprint(other));
    expect(auditFor(id, 'server.host_key_mismatch')).toHaveLength(2);
    expect(alertsFor(id)).toHaveLength(1);
  });

  it('pinning or forgetting clears the mismatch and resolves the alert', () => {
    const id = seedServer(orgId, userId);
    hk.checkHostKey(id, blobOf(ED25519_LINE), 'terminal');
    hk.checkHostKey(id, blobOf(RSA_LINE), 'terminal');

    hk.pinHostKey(row(id), RSA_FP, 'ssh-rsa', userId);
    expect(row(id)).toMatchObject({
      hostKeyFingerprint: RSA_FP,
      hostKeyTrustedBy: userId,
      hostKeyMismatchFingerprint: null,
    });
    expect(alertsFor(id)[0]!.resolvedAt).toBeTruthy();
    expect(hk.checkHostKey(id, blobOf(RSA_LINE), 'terminal').ok).toBe(true);

    hk.forgetHostKey(row(id));
    expect(hk.hostKeyStatus(row(id))).toBe('unknown');
    // Next connect is TOFU again
    expect(hk.checkHostKey(id, blobOf(ED25519_LINE), 'terminal').ok).toBe(true);
    expect(row(id).hostKeyFingerprint).toBe(ED25519_FP);
  });

  it('refuses when the server row is gone', () => {
    const result = hk.checkHostKey('no-such-server', blobOf(ED25519_LINE), 'exec');
    expect(result.ok).toBe(false);
  });

  it('the guard maps ssh2’s handshake error to the refusal reason', () => {
    const id = seedServer(orgId, userId);
    hk.checkHostKey(id, blobOf(ED25519_LINE), 'terminal');
    const guard = hk.hostKeyGuard(id, 'exec');
    const generic = new Error('Host denied (verification failed)');
    expect(guard.error(generic)).toBe(generic);
    expect(guard.hostVerifier(blobOf(RSA_LINE))).toBe(false);
    expect(guard.error(generic)).toBeInstanceOf(hk.HostKeyMismatchError);
  });

  it('refuses, without pinning or recording, a connection opened to an address the server no longer has', () => {
    // A connection (or a re-keying terminal) to the old address, verified
    // after an admin moved the server and its key was cleared
    const id = seedServer(orgId, userId);
    const staleGuard = hk.sshConnectConfig(
      { id, host: '10.0.0.1', port: 22, username: 'root' },
      { password: 'p' },
      'terminal',
    ).guard;
    getDb().update(servers).set({ host: '10.9.9.9', ...hk.clearedColumns() }).where(eq(servers.id, id)).run();

    expect(staleGuard.hostVerifier(blobOf(ED25519_LINE))).toBe(false);
    expect(staleGuard.error(new Error('Host denied'))).not.toBeInstanceOf(hk.HostKeyMismatchError);
    expect(row(id).hostKeyFingerprint).toBeNull();
    expect(auditFor(id, 'server.host_key_trusted')).toHaveLength(0);

    // Pinned for the new address: the old host's key is not a "mismatch" either
    hk.pinHostKey(row(id), RSA_FP, 'ssh-rsa', userId);
    expect(staleGuard.hostVerifier(blobOf(ED25519_LINE))).toBe(false);
    expect(row(id).hostKeyMismatchFingerprint).toBeNull();
    expect(alertsFor(id)).toHaveLength(0);

    // A connection to the current address is checked as usual
    const fresh = hk.sshConnectConfig(
      { id, host: '10.9.9.9', port: 22, username: 'root' },
      { password: 'p' },
      'terminal',
    ).guard;
    expect(fresh.hostVerifier(blobOf(RSA_LINE))).toBe(true);
  });

  it('sshConnectConfig asks for the pinned key type first, keeping the others', () => {
    const id = seedServer(orgId, userId);
    const target = { id, host: '10.0.0.1', port: 22, username: 'root' };
    // Nothing pinned: ssh2's defaults
    expect(hk.sshConnectConfig(target, { password: 'p' }, 'exec').config.algorithms).toBeUndefined();

    hk.checkHostKey(id, blobOf(RSA_LINE), 'exec');
    const rsa = ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'];
    const { config } = hk.sshConnectConfig(target, { password: 'p' }, 'exec');
    expect(config.algorithms).toEqual({ serverHostKey: { remove: rsa, prepend: rsa } });

    // What ssh2 actually offers: the pinned type first, then everything else
    const require = createRequire(import.meta.url);
    const utils = require('ssh2/lib/utils.js');
    const constants = require('ssh2/lib/protocol/constants.js');
    const offered: string[] = utils.generateAlgorithmList(
      (config.algorithms as any).serverHostKey,
      constants.DEFAULT_SERVER_HOST_KEY,
      constants.SUPPORTED_SERVER_HOST_KEY,
    );
    expect(offered.slice(0, 3)).toEqual(rsa);
    expect(offered).toContain('ssh-ed25519');

    // A pinned fingerprint with no known type yet leaves the defaults alone
    hk.pinHostKey(row(id), ED25519_FP, null, userId);
    expect(hk.sshConnectConfig(target, { password: 'p' }, 'exec').config.algorithms).toBeUndefined();
  });

  it('sshConnectConfig never lets a hostHash through (the verifier needs the raw blob)', () => {
    const { config } = hk.sshConnectConfig(
      { id: 'x', host: 'h', port: 22, username: 'u' },
      { password: 'p' },
      'exec',
      { hostHash: 'sha256' } as never,
    );
    expect(config.hostHash).toBeUndefined();
  });

  it('sshConnectConfig attaches the verifier and exactly one credential', () => {
    const { config } = hk.sshConnectConfig(
      { id: 'x', host: 'h', port: 2222, username: 'u' },
      { privateKey: 'k', password: 'p' },
      'exec',
      { readyTimeout: 5 },
    );
    expect(config).toMatchObject({ host: 'h', port: 2222, username: 'u', privateKey: 'k', readyTimeout: 5 });
    expect(config.password).toBeUndefined();
    expect(typeof config.hostVerifier).toBe('function');
  });
});

describe('scanHostKey', () => {
  it('captures the presented key without authenticating and stores nothing', async () => {
    state.presented = blobOf(ED25519_LINE);
    const result = await hk.scanHostKey('10.0.0.9', 22);
    expect(result).toEqual({ fingerprint: ED25519_FP, type: 'ssh-ed25519' });
    const cfg = state.configs.at(-1);
    expect(cfg.password).toBeUndefined();
    expect(cfg.privateKey).toBeUndefined();
    expect(cfg.host).toBe('10.0.0.9');
  });
});
