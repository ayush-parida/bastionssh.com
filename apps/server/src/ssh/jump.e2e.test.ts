import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { eq } from 'drizzle-orm';
import { Server, utils } from 'ssh2';

// Real ssh2 on both ends, on loopback: a bastion that only forwards
// direct-tcpip channels, and a target that only runs commands. Proves the
// tunnel works with ssh2's actual `sock` handling, not just with a fake.

const { runMigrations } = await import('../db/migrate.js');
const { getDb } = await import('../db/index.js');
const { servers } = await import('../db/schema.js');
const { seedOrg, seedUser, seedServer } = await import('../api/routes/test-utils.js');
const { hostKeyFingerprint, pinnedColumns, HostKeyMismatchError } = await import('./host-keys.js');
const { execOnServer } = await import('./broker.js');
const { vault } = await import('../vault/index.js');

function hostKey() {
  const { private: key } = utils.generateKeyPairSync('ed25519');
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error) throw parsed;
  return { key, fingerprint: hostKeyFingerprint(parsed.getPublicSSH()) };
}

const bastionKey = hostKey();
const targetKey = hostKey();

/** Live connections to the bastion, and the destinations it was asked to reach. */
const bastionClients = new Set<unknown>();
const forwarded: string[] = [];

const target = new Server({ hostKeys: [targetKey.key] }, (client) => {
  client
    .on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === 'pw-target') ctx.accept();
      else ctx.reject(['password']);
    })
    .on('ready', () => {
      client.on('session', (accept) => {
        accept().once('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(`target ran: ${info.command}`);
          stream.exit(0);
          stream.end();
        });
      });
    })
    .on('error', () => {});
});

const bastion = new Server({ hostKeys: [bastionKey.key] }, (client) => {
  bastionClients.add(client);
  client
    .on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === 'pw-bastion') ctx.accept();
      else ctx.reject(['password']);
    })
    .on('ready', () => {
      client.on('tcpip', (accept, _reject, info) => {
        forwarded.push(`${info.destIP}:${info.destPort}`);
        const channel = accept();
        const upstream = net.connect(info.destPort, info.destIP);
        upstream.on('error', () => channel.close());
        channel.pipe(upstream).pipe(channel);
      });
    })
    .on('close', () => bastionClients.delete(client))
    .on('error', () => {});
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

let orgId: string;
let userId: string;
let bastionId: string;
let targetId: string;
let bastionPort: number;
let targetPort: number;

async function seed(name: string, port: number, password: string, jumpServerId: string | null) {
  const id = seedServer(orgId, userId, name);
  getDb()
    .update(servers)
    .set({ host: '127.0.0.1', port, jumpServerId, encryptedPassword: await vault.encrypt(password, id) })
    .where(eq(servers.id, id))
    .run();
  return id;
}

function row(id: string) {
  return getDb().select().from(servers).where(eq(servers.id, id)).get()!;
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
}

beforeAll(async () => {
  await runMigrations();
  orgId = seedOrg('jump-e2e');
  userId = seedUser(orgId, 'admin').userId;
  bastionPort = await listen(bastion);
  targetPort = await listen(target);
});

afterAll(() => {
  bastion.close();
  target.close();
});

beforeEach(async () => {
  forwarded.length = 0;
  bastionId = await seed('bastion', bastionPort, 'pw-bastion', null);
  targetId = await seed('target', targetPort, 'pw-target', bastionId);
});

describe('jump hosts over real ssh2', () => {
  it('runs a command on the target through the bastion, pinning each host its own key', async () => {
    const result = await execOnServer(
      { id: targetId, host: '127.0.0.1', port: targetPort, username: 'root' },
      { password: 'pw-target' },
      'uptime',
      10_000,
      undefined,
      { actorUserId: userId },
    );
    expect(result).toMatchObject({ stdout: 'target ran: uptime', exitCode: 0 });
    expect(forwarded).toEqual([`127.0.0.1:${targetPort}`]);
    expect(row(bastionId).hostKeyFingerprint).toBe(bastionKey.fingerprint);
    expect(row(targetId).hostKeyFingerprint).toBe(targetKey.fingerprint);

    // The bastion connection goes away with the target's
    await waitFor(() => bastionClients.size === 0);
    expect(bastionClients.size).toBe(0);
  });

  it("refuses a target whose key over the tunnel is not the pinned one, and hangs up on the bastion", async () => {
    getDb().update(servers).set(pinnedColumns(bastionKey.fingerprint, 'ssh-ed25519', userId)).where(eq(servers.id, targetId)).run();

    const err = await execOnServer(
      { id: targetId, host: '127.0.0.1', port: targetPort, username: 'root' },
      { password: 'pw-target' },
      'uptime',
      10_000,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(HostKeyMismatchError);
    expect(err).toMatchObject({ serverId: targetId, presented: targetKey.fingerprint });
    expect(forwarded).toHaveLength(1);

    await waitFor(() => bastionClients.size === 0);
    expect(bastionClients.size).toBe(0);
  });
});
