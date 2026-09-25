import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { servers, sshKeys } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { vault } from '../../vault/index.js';
import { seedOrg, seedUser } from './test-utils.js';

const { utils } = ssh2;

describe('ssh key routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let outsider: ReturnType<typeof seedUser>;

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-keys');
    admin = seedUser(orgId, 'admin');
    outsider = seedUser(seedOrg('org-keys-b'), 'owner');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const generate = (type: string) =>
    app.inject({
      method: 'POST',
      url: '/api/keys/generate',
      headers: admin.headers,
      payload: { name: `gen-${type}`, type },
    });

  it.each(['ed25519', 'ecdsa', 'rsa'])(
    'generates a %s key that ssh2 can use, in the shared response shape',
    async (type) => {
      const res = await generate(type);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.key).toMatchObject({ orgId, name: `gen-${type}`, type, keyVersion: 1 });
      expect(body.key.encryptedPrivateKey).toBeUndefined();

      const parsed = utils.parseKey(body.privateKeyPem);
      if (parsed instanceof Error) throw parsed;
      expect(parsed.isPrivateKey()).toBe(true);

      // One-line authorized_keys entry and an ssh-keygen style fingerprint
      expect(body.key.publicKey).toMatch(
        /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+/,
      );
      const blob = createHash('sha256').update(parsed.getPublicSSH()).digest('base64');
      expect(body.key.fingerprint).toBe(`SHA256:${blob.replace(/=+$/, '')}`);

      // What the vault stores is the same usable key
      const row = getDb().select().from(sshKeys).where(eq(sshKeys.id, body.key.id)).get()!;
      expect(await vault.decrypt(row.encryptedPrivateKey, row.id)).toBe(body.privateKeyPem);
    },
    30_000,
  );

  it('imports an OpenSSH key with its real type, public key and fingerprint', async () => {
    const pair = utils.generateKeyPairSync('ed25519', { comment: 'me@host' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/keys/import',
      headers: admin.headers,
      payload: { name: 'imported', privateKey: pair.private },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.type).toBe('ed25519');
    expect(body.publicKey).toBe(pair.public);
    expect(body.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('imports a PKCS1 RSA key as rsa', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/keys/import',
      headers: admin.headers,
      payload: { name: 'pkcs1', privateKey },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().type).toBe('rsa');
    expect(res.json().publicKey).toMatch(/^ssh-rsa /);
  });

  it.each([
    ['garbage', () => 'not a key', /Could not parse/],
    [
      'a PKCS8 key ssh2 cannot read',
      () =>
        generateKeyPairSync('ed25519', {
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        }).privateKey,
      /Could not parse/,
    ],
    ['a public key', () => utils.generateKeyPairSync('ed25519').public, /public key/],
    [
      'a passphrase-protected key',
      () =>
        utils.generateKeyPairSync('ed25519', { passphrase: 'pw', cipher: 'aes256-ctr', rounds: 16 })
          .private,
      /Passphrase/,
    ],
  ])('rejects %s with a 400 and stores nothing', async (_label, make, message) => {
    const before = getDb().select().from(sshKeys).all().length;
    const res = await app.inject({
      method: 'POST',
      url: '/api/keys/import',
      headers: admin.headers,
      payload: { name: 'bad', privateKey: make() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(message);
    expect(getDb().select().from(sshKeys).all().length).toBe(before);
  });

  it('refuses to delete a key a server uses, with a 409 naming the server', async () => {
    const keyId = (await generate('ed25519')).json().key.id;
    const serverId = 'srv-uses-key';
    getDb()
      .insert(servers)
      .values({
        id: serverId,
        orgId,
        createdBy: admin.userId,
        name: 'web-1',
        host: '10.0.0.1',
        username: 'root',
        defaultKeyId: keyId,
      })
      .run();

    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/keys/${keyId}`,
      headers: admin.headers,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatch(/web-1/);

    getDb().update(servers).set({ defaultKeyId: null }).where(eq(servers.id, serverId)).run();
    const ok = await app.inject({
      method: 'DELETE',
      url: `/api/keys/${keyId}`,
      headers: admin.headers,
    });
    expect(ok.statusCode).toBe(204);
  });

  it('does not let another org delete the key', async () => {
    const keyId = (await generate('ed25519')).json().key.id;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/keys/${keyId}`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});
