import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * The API transport and client against an in-process fake API server
 * (fake-api.test-helper.ts) with a test CA — reached directly, and through a
 * managed server's SSH connection whose `forwardOut` is a stand-in that
 * dials the fake server. What is under test: TLS is verified against the
 * cluster CA (never skipped), SNI and the name check use the API URL's host
 * whatever the route, credentials are sent, and lists and watches work.
 */
const fake = vi.hoisted(() => ({
  target: 0,
  forwards: [] as { host: string; port: number }[],
  refuse: false,
}));

vi.mock('ssh2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ssh2')>();
  const { EventEmitter } = await import('node:events');
  const net = await import('node:net');
  class Client extends EventEmitter {
    connect() {
      setImmediate(() => this.emit('ready'));
      return this;
    }
    forwardOut(_srcIP: string, _srcPort: number, host: string, port: number, cb: (err: Error | undefined, ch?: unknown) => void) {
      fake.forwards.push({ host, port });
      setImmediate(() => {
        if (fake.refuse) return cb(Object.assign(new Error('Connection refused'), { reason: 2 }));
        cb(undefined, net.connect(fake.target, '127.0.0.1'));
      });
    }
    end() {
      setImmediate(() => this.emit('close'));
      return this;
    }
  }
  return { ...actual, default: { ...(actual as { default?: object }).default, Client }, Client };
});

import { eq } from 'drizzle-orm';
import { runMigrations } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { servers } from '../db/schema.js';
import { vault } from '../vault/index.js';
import { seedOrg, seedServer, seedUser } from '../api/routes/test-utils.js';
import { clientFor, type ClientParams } from './service.js';
import { KubeError } from './errors.js';
import { evictKubeServer } from './ssh-pool.js';
import { FAKE_TOKEN, pod, startFakeApi, type FakeApi } from './fake-api.test-helper.js';
import { CA_CERT, CLIENT_CERT, CLIENT_KEY, OTHER_CA } from './test-certs.test-helper.js';
import type { WatchEvent } from './client.js';

describe('kube transport and client', () => {
  let api: FakeApi;
  let certApi: FakeApi;
  let orgId: string;
  let serverId: string;

  const direct = (overrides: Partial<ClientParams> = {}) =>
    clientFor({
      orgId,
      apiUrl: api.url,
      caData: CA_CERT,
      credential: { type: 'token', token: FAKE_TOKEN },
      connectVia: 'direct',
      viaServerId: null,
      viaAgentId: null,
      ...overrides,
    });

  async function failure(promise: Promise<unknown>): Promise<KubeError> {
    try {
      await promise;
    } catch (err) {
      return err as KubeError;
    }
    throw new Error('expected a failure');
  }

  beforeAll(async () => {
    await runMigrations();
    api = await startFakeApi();
    certApi = await startFakeApi({ clientCa: CA_CERT });
    orgId = seedOrg('kube-transport');
    serverId = seedServer(orgId, seedUser(orgId, 'admin').userId, 'bastion');
    getDb()
      .update(servers)
      .set({ encryptedPassword: await vault.encrypt('pw', serverId) })
      .where(eq(servers.id, serverId))
      .run();
  });

  afterAll(async () => {
    await api.close();
    await certApi.close();
  });

  beforeEach(() => {
    fake.target = api.port;
    fake.forwards = [];
    fake.refuse = false;
    evictKubeServer(orgId, serverId);
  });

  it('reaches the API directly, verified against the cluster CA, with the token', async () => {
    const client = direct();
    expect((await client.version()).gitVersion).toBe('v1.31.2+fake');
    await client.raw('/api');
    // An IP address gets no SNI (TLS forbids it); its certificate names 127.0.0.1
    expect(api.sni.at(-1)).toBe('');
    client.close();
  });

  it('refuses a certificate from another CA, and does not fall back to trusting it', async () => {
    const wrong = await failure(direct({ caData: OTHER_CA }).version());
    expect(wrong).toBeInstanceOf(KubeError);
    expect(wrong.message).toMatch(/TLS verification failed/);
    expect(wrong.reason).toBe('TLSVerify');
    // No CA given: the system trust store, which does not know the test CA either
    expect((await failure(direct({ caData: null }).version())).message).toMatch(/TLS verification failed/);
  });

  it('refuses a wrong token as the cluster refusing the credential', async () => {
    const err = await failure(direct({ credential: { type: 'token', token: 'nope' } }).raw('/api'));
    expect(err.statusCode).toBe(502);
    expect(err.message).toMatch(/refused the stored credential/);
  });

  it('presents a client certificate in the handshake', async () => {
    const client = direct({ apiUrl: certApi.url, credential: { type: 'cert', cert: CLIENT_CERT, key: CLIENT_KEY } });
    await expect(client.raw('/api')).resolves.toBeTruthy();
  });

  it('never dials metadata or link-local addresses directly', async () => {
    const err = await failure(direct({ apiUrl: 'https://169.254.169.254:6443' }).version());
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/Refusing to connect/);
  });

  it('tunnels through a managed server with forwardOut, keeping SNI and the name check on the API host', async () => {
    const client = direct({ apiUrl: 'https://kube.test:6443', connectVia: 'server', viaServerId: serverId });
    expect((await client.version()).gitVersion).toBe('v1.31.2+fake');
    expect(fake.forwards).toContainEqual({ host: 'kube.test', port: 6443 });
    expect(api.sni.at(-1)).toBe('kube.test');

    // The certificate does not name this host: refused, even though the bytes reach the right server
    const wrongName = await failure(direct({ apiUrl: 'https://other.test:6443', connectVia: 'server', viaServerId: serverId }).version());
    expect(wrongName.message).toMatch(/does not cover the API server name/);
  });

  it('explains a server that cannot reach the API', async () => {
    fake.refuse = true;
    const err = await failure(direct({ apiUrl: 'https://kube.test:6443', connectVia: 'server', viaServerId: serverId }).version());
    expect(err.message).toMatch(/could not open a connection to kube\.test:6443/);
  });

  it('lists every page and watches from the list’s version', async () => {
    for (let i = 0; i < 520; i++) api.add('pods', pod('paged', `p-${i}`));
    const client = direct();
    const list = await client.list('pods', { namespace: 'paged' });
    expect(list.items).toHaveLength(520);
    expect(list.items[0]!.kind).toBe('Pod');
    expect(api.requests.some((r) => r.includes('/namespaces/paged/pods?limit=500&continue=500'))).toBe(true);

    const events: WatchEvent[] = [];
    const abort = new AbortController();
    const watching = client.watch('pods', { namespace: 'paged', resourceVersion: list.resourceVersion, signal: abort.signal }, (e) => {
      events.push(e);
      if (e.type === 'DELETED') abort.abort();
    });
    await new Promise((r) => setTimeout(r, 50));
    api.add('pods', pod('paged', 'new'));
    api.remove('pods', 'paged', 'p-0');
    await watching;
    expect(events.map((e) => [e.type, e.object.metadata.name])).toEqual([
      ['BOOKMARK', undefined],
      ['ADDED', 'new'],
      ['DELETED', 'p-0'],
    ]);
    client.close();
  });
});
