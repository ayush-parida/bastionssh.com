import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { Client } from 'ssh2';

/**
 * Runs only against a real OpenSSH server that accepts a key you hold, e.g.:
 *
 *   ssh-keygen -t ed25519 -N '' -f /tmp/rot_key
 *   docker run -d --rm -p 2223:2222 -e USER_NAME=rot -e PUBLIC_KEY="$(cat /tmp/rot_key.pub)" \
 *     --name smt-rotation-test lscr.io/linuxserver/openssh-server
 *   SMT_TEST_SSH_HOST=127.0.0.1 SMT_TEST_SSH_PORT=2223 SMT_TEST_SSH_USER=rot SMT_TEST_SSH_KEY_FILE=/tmp/rot_key \
 *     pnpm vitest run src/ssh/key-rotation.integration.test.ts
 *   docker stop smt-rotation-test
 *
 * Rotates twice through the real API, broker, host key store and ssh2, then
 * checks with raw connections which keys the server still accepts.
 */

const host = process.env.SMT_TEST_SSH_HOST;
const port = Number(process.env.SMT_TEST_SSH_PORT ?? 22);
const username = process.env.SMT_TEST_SSH_USER ?? 'rot';
const keyFile = process.env.SMT_TEST_SSH_KEY_FILE;

const { eq } = await import('drizzle-orm');
const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { getDb } = await import('../db/index.js');
const { servers, sshKeys } = await import('../db/schema.js');
const { vault } = await import('../vault/index.js');
const { seedOrg, seedServer, seedUser } = await import('../api/routes/test-utils.js');

/** Whether the server accepts this key, and what `cat authorized_keys` shows over it. */
function tryLogin(privateKey: string): Promise<string | null> {
  return new Promise((resolve) => {
    const client = new Client();
    client
      .on('ready', () =>
        client.exec('cat ~/.ssh/authorized_keys', (err, stream) => {
          if (err) return resolve(null);
          let out = '';
          stream.on('data', (d: Buffer) => (out += d.toString()));
          stream.on('close', () => {
            client.end();
            resolve(out);
          });
        }),
      )
      .on('error', () => resolve(null))
      .connect({ host, port, username, privateKey, hostVerifier: () => true, readyTimeout: 10_000 });
  });
}

describe.skipIf(!host || !keyFile)('key rotation against a live OpenSSH server', { timeout: 60_000 }, () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: ReturnType<typeof seedUser>;
  let serverId: string;
  let originalPrivate: string;

  beforeAll(async () => {
    await runMigrations();
    const orgId = seedOrg('rotation-it');
    admin = seedUser(orgId, 'admin');
    originalPrivate = fs.readFileSync(keyFile!, 'utf8');
    const keyId = 'it-original-key';
    getDb()
      .insert(sshKeys)
      .values({
        id: keyId,
        orgId,
        name: 'original',
        type: 'ed25519',
        publicKey: fs.readFileSync(`${keyFile}.pub`, 'utf8').trim(),
        fingerprint: 'SHA256:it',
        encryptedPrivateKey: await vault.encrypt(originalPrivate, keyId),
        createdBy: admin.userId,
      })
      .run();
    serverId = seedServer(orgId, admin.userId, 'live');
    getDb().update(servers).set({ host, port, username, defaultKeyId: keyId }).where(eq(servers.id, serverId)).run();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function rotate() {
    const res = await app.inject({ method: 'POST', url: `/api/servers/${serverId}/rotate-key`, headers: admin.headers, payload: {} });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function privateKeyOf(id: string) {
    const row = getDb().select().from(sshKeys).where(eq(sshKeys.id, id)).get()!;
    return { row, pem: await vault.decrypt(row.encryptedPrivateKey, row.id) };
  }

  it('rotates twice; each time only the new key is still accepted', async () => {
    const first = await rotate();
    expect(first).toMatchObject({ status: 'completed', warnings: [], oldKeyRetired: true });
    expect(await tryLogin(originalPrivate)).toBeNull();
    const k1 = await privateKeyOf(first.newKeyId);
    const listing = await tryLogin(k1.pem);
    expect(listing).toContain(`bastionssh-key-${first.newKeyId}`);

    const second = await rotate();
    expect(second).toMatchObject({ status: 'completed', warnings: [], oldKeyRetired: true, oldKeyId: first.newKeyId });
    expect(await tryLogin(k1.pem)).toBeNull();
    const k2 = await privateKeyOf(second.newKeyId);
    const after = await tryLogin(k2.pem);
    expect(after).toContain(`bastionssh-key-${second.newKeyId}`);
    expect(after).not.toContain(k1.row.publicKey.split(' ')[1]);
  });
});
