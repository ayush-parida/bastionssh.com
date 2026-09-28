import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { agents, auditLog, servers } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { seedOrg, seedUser } from './test-utils.js';

describe('server routes: default key ownership', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: ReturnType<typeof seedUser>;
  let otherAdmin: ReturnType<typeof seedUser>;
  let ownKeyId: string;
  let foreignKeyId: string;

  const newKey = async (headers: Record<string, string>) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/keys/generate',
        headers,
        payload: { name: 'k', type: 'ed25519' },
      })
    ).json().key.id as string;

  const serverBody = (defaultKeyId: string) => ({
    name: 'web',
    host: '10.0.0.5',
    username: 'root',
    authType: 'key',
    defaultKeyId,
  });

  beforeAll(async () => {
    await runMigrations();
    admin = seedUser(seedOrg('org-srv-a'), 'admin');
    otherAdmin = seedUser(seedOrg('org-srv-b'), 'admin');
    app = await buildApp();
    await app.ready();
    ownKeyId = await newKey(admin.headers);
    foreignKeyId = await newKey(otherAdmin.headers);
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a key from the caller org', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: admin.headers,
      payload: serverBody(ownKeyId),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().defaultKeyId).toBe(ownKeyId);
  });

  it("rejects another org's key on create", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: admin.headers,
      payload: serverBody(foreignKeyId),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects another org's key on update and leaves the server unchanged", async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: admin.headers,
      payload: serverBody(ownKeyId),
    });
    const id = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${id}`,
      headers: admin.headers,
      payload: { authType: 'key', defaultKeyId: foreignKeyId },
    });
    expect(res.statusCode).toBe(400);
    const row = getDb().select().from(servers).where(eq(servers.id, id)).get()!;
    expect(row.defaultKeyId).toBe(ownKeyId);
  });
});

describe('server routes: jump hosts', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: ReturnType<typeof seedUser>;
  let operator: ReturnType<typeof seedUser>;
  let foreignAdmin: ReturnType<typeof seedUser>;

  const create = (payload: Record<string, unknown>, headers = admin.headers) =>
    app.inject({
      method: 'POST',
      url: '/api/servers',
      headers,
      payload: { host: '10.0.0.9', username: 'root', authType: 'password', password: 'pw', ...payload },
    });
  const patch = (id: string, payload: Record<string, unknown>, headers = admin.headers) =>
    app.inject({ method: 'PATCH', url: `/api/servers/${id}`, headers, payload });
  const jumpOf = (id: string) =>
    getDb().select().from(servers).where(eq(servers.id, id)).get()?.jumpServerId;

  beforeAll(async () => {
    await runMigrations();
    const orgId = seedOrg('org-jump-a');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    foreignAdmin = seedUser(seedOrg('org-jump-b'), 'admin');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a server behind a jump host and returns it on reads', async () => {
    const bastion = (await create({ name: 'bastion' })).json().id;
    const res = await create({ name: 'db', jumpServerId: bastion });
    expect(res.statusCode).toBe(201);
    expect(res.json().jumpServerId).toBe(bastion);

    const list = await app.inject({ method: 'GET', url: '/api/servers', headers: operator.headers });
    const direct = list.json().find((s: { id: string }) => s.id === bastion);
    expect(direct.jumpServerId).toBeNull();
    const behind = list.json().find((s: { id: string }) => s.id === res.json().id);
    expect(behind.jumpServerId).toBe(bastion);
  });

  it("rejects an unknown or another org's server as jump host", async () => {
    const foreign = (await create({ name: 'theirs' }, foreignAdmin.headers)).json().id;
    expect((await create({ name: 'x', jumpServerId: foreign })).statusCode).toBe(400);
    expect((await create({ name: 'x', jumpServerId: 'missing' })).statusCode).toBe(400);
    const own = (await create({ name: 'mine' })).json().id;
    expect((await patch(own, { jumpServerId: foreign })).statusCode).toBe(400);
    expect(jumpOf(own)).toBeNull();
  });

  it('rejects a server as its own jump host and loops', async () => {
    const a = (await create({ name: 'a' })).json().id;
    const b = (await create({ name: 'b', jumpServerId: a })).json().id;
    expect((await patch(a, { jumpServerId: a })).statusCode).toBe(400);
    const loop = await patch(a, { jumpServerId: b });
    expect(loop.statusCode).toBe(400);
    expect(loop.json().error).toMatch(/loop/);
    expect(jumpOf(a)).toBeNull();
  });

  it('limits chains to three hops, counting servers already behind the one being changed', async () => {
    const h1 = (await create({ name: 'h1' })).json().id;
    const h2 = (await create({ name: 'h2', jumpServerId: h1 })).json().id;
    const h3 = (await create({ name: 'h3', jumpServerId: h2 })).json().id;
    const leaf = await create({ name: 'leaf', jumpServerId: h3 });
    expect(leaf.statusCode).toBe(201);
    expect((await create({ name: 'too-deep', jumpServerId: leaf.json().id })).statusCode).toBe(400);

    // Giving h1 a jump host would put leaf four hops away
    const edge = (await create({ name: 'edge' })).json().id;
    const res = await patch(h1, { jumpServerId: edge });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/3 hops/);
    expect(jumpOf(h1)).toBeNull();
  });

  it('changes and clears the jump host, auditing the change', async () => {
    const j1 = (await create({ name: 'j1' })).json().id;
    const j2 = (await create({ name: 'j2' })).json().id;
    const id = (await create({ name: 'behind', jumpServerId: j1 })).json().id;

    expect((await patch(id, { jumpServerId: j2 })).json().jumpServerId).toBe(j2);
    // Other edits leave it alone
    expect((await patch(id, { notes: 'hi' })).json().jumpServerId).toBe(j2);
    expect((await patch(id, { jumpServerId: null })).json().jumpServerId).toBeNull();

    const updates = getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'server.update'), eq(auditLog.resourceId, id)))
      .all()
      .map((row) => (row.metadata ? JSON.parse(row.metadata) : null));
    expect(updates).toEqual([
      { jumpServerId: { from: j1, to: j2 } },
      null,
      { jumpServerId: { from: j2, to: null } },
    ]);
  });

  it('only admins can set a jump host', async () => {
    const j = (await create({ name: 'j' })).json().id;
    const id = (await create({ name: 's' })).json().id;
    expect((await patch(id, { jumpServerId: j }, operator.headers)).statusCode).toBe(403);
    expect(jumpOf(id)).toBeNull();
  });

  it('deleting a jump host makes the servers behind it direct', async () => {
    const j = (await create({ name: 'doomed' })).json().id;
    const id = (await create({ name: 'survivor', jumpServerId: j })).json().id;
    const res = await app.inject({ method: 'DELETE', url: `/api/servers/${j}`, headers: admin.headers });
    expect(res.statusCode).toBe(204);
    expect(jumpOf(id)).toBeNull();
  });

  it('refuses a jump host and a connectivity agent on the same server', async () => {
    const edge = (await create({ name: 'edge-host' })).json();
    const j = edge.id as string;
    const agentId = 'agent-jump-a';
    getDb()
      .insert(agents)
      .values({ id: agentId, orgId: edge.orgId, name: 'a', tokenHash: 'hash-jump-a', createdBy: admin.userId })
      .run();
    expect((await create({ name: 'both', jumpServerId: j, agentId })).statusCode).toBe(400);

    const viaAgent = (await create({ name: 'via-agent', agentId })).json().id;
    expect((await patch(viaAgent, { jumpServerId: j })).statusCode).toBe(400);
    expect(jumpOf(viaAgent)).toBeNull();
    // Swapping the route in one request is fine
    const swapped = await patch(viaAgent, { jumpServerId: j, agentId: null });
    expect(swapped.statusCode).toBe(200);
    expect(swapped.json()).toMatchObject({ jumpServerId: j, agentId: null });
    expect((await patch(viaAgent, { agentId })).statusCode).toBe(400);

    // A jump host may itself sit behind an agent: it is the hop this app reaches first
    expect((await patch(j, { agentId })).statusCode).toBe(200);
  });
});
