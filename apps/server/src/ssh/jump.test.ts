import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';

// Fake ssh2 that runs the host key handshake per host: connect() hands the key
// in `state.keys[host]` to the configured hostVerifier and fails with ssh2's
// own error when it is refused. forwardOut() returns a channel that a later
// connect() may receive as `sock`. Every client, config and forward is
// recorded. Methods only, state in a closure (see vitest-mock-class-fields).
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');
  const state = {
    keys: {} as Record<string, Buffer>,
    connects: [] as { client: any; cfg: any }[],
    forwards: [] as { client: any; host: string; port: number; channel: any }[],
    ended: new Set<any>(),
    forwardError: undefined as string | undefined,
    /** Hosts whose connect() never completes. */
    hang: new Set<string>(),
  };

  function channel(output: string) {
    const ch: any = new EventEmitter();
    ch.stderr = new EventEmitter();
    ch.writable = true;
    ch.write = () => {};
    ch.close = () => {};
    setImmediate(() => {
      ch.emit('data', Buffer.from(output));
      ch.emit('exit', 0);
      ch.emit('close', 0);
    });
    return ch;
  }

  class Client extends EventEmitter {
    connect(cfg: any) {
      state.connects.push({ client: this, cfg });
      if (state.hang.has(cfg.host)) return this;
      setImmediate(() => {
        const key = state.keys[cfg.host] ?? Buffer.alloc(0);
        if (typeof cfg.hostVerifier !== 'function' || cfg.hostVerifier(key) === false) {
          this.emit('error', new Error('Host denied (verification failed)'));
          this.emit('close');
          return;
        }
        this.emit('ready');
      });
      return this;
    }
    end() {
      if (state.ended.has(this)) return this;
      state.ended.add(this);
      setImmediate(() => this.emit('close'));
      return this;
    }
    forwardOut(_src: string, _srcPort: number, host: string, port: number, cb: (err: Error | undefined, ch: any) => void) {
      const ch: any = new EventEmitter();
      ch.forwardedTo = `${host}:${port}`;
      state.forwards.push({ client: this, host, port, channel: ch });
      setImmediate(() => {
        if (state.forwardError) cb(new Error(state.forwardError), undefined);
        else cb(undefined, ch);
      });
    }
    exec(_cmd: string, cb: (err: Error | undefined, ch: any) => void) {
      cb(undefined, channel('hostname fake\nuptime 100 50\n'));
    }
    shell(_opts: unknown, cb: (err: Error | undefined, ch: any) => void) {
      const ch: any = new EventEmitter();
      ch.stderr = new EventEmitter();
      cb(undefined, ch);
    }
    sftp(cb: (err: Error | undefined, sftp: unknown) => void) {
      cb(undefined, {});
    }
  }
  return { Client, __state: state };
});

const { __state: state } = (await import('ssh2')) as any;
const { runMigrations } = await import('../db/migrate.js');
const { getDb } = await import('../db/index.js');
const { auditLog, memberServerAccess, memberships, servers } = await import('../db/schema.js');
const { seedOrg, seedUser, seedServer } = await import('../api/routes/test-utils.js');
const { HostKeyMismatchError, pinnedColumns } = await import('./host-keys.js');
const { SSHBroker, execOnServer } = await import('./broker.js');
const sftp = await import('./sftp.js');
const { runProbe } = await import('../monitoring/probe.js');
const { checkServerById } = await import('../monitoring/collector.js');
const { JumpHostError, MAX_JUMP_DEPTH, jumpChain, jumpHostProblem, scanServerHostKey, serversBehind } =
  await import('./jump.js');
const { vault } = await import('../vault/index.js');

const JUMP_KEY = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIElIFDlvr3BbqwqJML2vALk7zEJk8g6g/KL13zhz+dh8', 'base64');
const JUMP_FP = 'SHA256:7RzRboFL75PCBozdMj7VbF+Y5sel8sTZxSqUkmATKNk';
const TARGET_KEY = Buffer.from(
  'AAAAB3NzaC1yc2EAAAADAQABAAABAQDBzrp2STH2pmmNlq1rKViosIU1Jn76TBXiFnLSIpPseBjWjL39HNtoWHk8WMGC4dkqftSt4H56RUCtWNflzAoZau9xNp5x0X3m36igPHLTqLU369J9MaNPx8Fl9V9uX5MZg5sYUQPlm/39pR6lbrN3kSvbmMUPTBjsDCnzMm07DOG8cUcPgP6ozDjDG97WmWoaCjnNbY1naclVjaYvRDGqxxheg0ZOXukugTAPj/bfzTtUA8WrQ2jwSknnI2j3I8+0fKcNlJlwUO/samY+A4D6DaUgQw28dlrRcQL9X9Z02+rzObOA9zx0OogotKH2lZsSeuPsq9UuB0nLeAbksrMx',
  'base64',
);
const TARGET_FP = 'SHA256:S7Axguai+B29/IGiF9tcSRxdklcSxD2vNoSLuUdBD8U';

const flush = () => new Promise((r) => setImmediate(r));

let orgId: string;
let userId: string;
let jumpId: string;
let targetId: string;

/** A server with its own password, at `host`, optionally behind `jumpServerId`. */
async function server(name: string, host: string, jumpServerId: string | null = null) {
  const id = seedServer(orgId, userId, name);
  getDb()
    .update(servers)
    .set({ host, jumpServerId, encryptedPassword: await vault.encrypt(`pw-${name}`, id) })
    .where(eq(servers.id, id))
    .run();
  return id;
}

function target() {
  return { id: targetId, host: '10.0.0.5', port: 22, username: 'root' };
}

function row(id: string) {
  return getDb().select().from(servers).where(eq(servers.id, id)).get()!;
}

function jumpAudits(resourceId: string) {
  return getDb()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'server.jump'), eq(auditLog.resourceId, resourceId)))
    .all();
}

/** The two hops of a single-jump connection: bastion first, then the target over its channel. */
function expectBothHopsVerified() {
  const [jumpHop, targetHop] = state.connects;
  expect(state.connects).toHaveLength(2);

  expect(jumpHop.cfg).toMatchObject({ host: 'bastion.example', port: 22, password: 'pw-bastion' });
  expect(typeof jumpHop.cfg.hostVerifier).toBe('function');
  expect(jumpHop.cfg.sock).toBeUndefined();

  expect(state.forwards).toHaveLength(1);
  expect(state.forwards[0]).toMatchObject({ client: jumpHop.client, host: '10.0.0.5', port: 22 });

  expect(targetHop.cfg).toMatchObject({ host: '10.0.0.5', port: 22 });
  expect(typeof targetHop.cfg.hostVerifier).toBe('function');
  expect(targetHop.cfg.sock).toBe(state.forwards[0].channel);
  // The jump host's credentials never reach the target
  expect(targetHop.cfg.password).not.toBe('pw-bastion');

  // Each hop pinned its own key on first use
  expect(row(jumpId).hostKeyFingerprint).toBe(JUMP_FP);
  expect(row(targetId).hostKeyFingerprint).toBe(TARGET_FP);
  return { jumpHop, targetHop };
}

beforeAll(async () => {
  await runMigrations();
  orgId = seedOrg('jump-hosts');
  userId = seedUser(orgId, 'admin').userId;
});

beforeEach(async () => {
  state.connects.length = 0;
  state.forwards.length = 0;
  state.ended.clear();
  state.forwardError = undefined;
  state.hang.clear();
  state.keys = { 'bastion.example': JUMP_KEY, '10.0.0.5': TARGET_KEY };
  jumpId = await server('bastion', 'bastion.example');
  targetId = await server('db', '10.0.0.5', jumpId);
});

describe('connecting through a jump host', () => {
  it('execOnServer verifies both host keys, tunnels the target over the jump channel and audits the hop', async () => {
    const result = await execOnServer(target(), { password: 'pw-db' }, 'uptime', 5_000, undefined, {
      actorUserId: userId,
    });
    expect(result.exitCode).toBe(0);

    const { jumpHop, targetHop } = expectBothHopsVerified();
    expect(targetHop.cfg.password).toBe('pw-db');
    await flush();
    // The jump connection goes away with the target's
    expect(state.ended.has(targetHop.client)).toBe(true);
    expect(state.ended.has(jumpHop.client)).toBe(true);

    const [entry] = jumpAudits(jumpId);
    expect(entry).toMatchObject({ actorId: userId, resourceType: 'server', resourceName: 'bastion' });
    expect(JSON.parse(entry!.metadata!)).toMatchObject({ targetId, to: '10.0.0.5:22', via: 'exec' });
  });

  it('refuses a changed jump host key before tunnelling anywhere', async () => {
    getDb().update(servers).set(pinnedColumns(TARGET_FP, 'ssh-rsa', userId)).where(eq(servers.id, jumpId)).run();

    const err = await execOnServer(target(), { password: 'pw-db' }, 'uptime', 5_000, undefined, {
      actorUserId: userId,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(HostKeyMismatchError);
    expect(err).toMatchObject({ serverId: jumpId, expected: TARGET_FP, presented: JUMP_FP });
    // Only the jump host was contacted, and nothing was forwarded
    expect(state.connects).toHaveLength(1);
    expect(state.forwards).toHaveLength(0);
    expect(jumpAudits(jumpId)).toHaveLength(0);
  });

  it('refuses a changed target key over the tunnel and closes the jump connection', async () => {
    getDb().update(servers).set(pinnedColumns(JUMP_FP, 'ssh-ed25519', userId)).where(eq(servers.id, targetId)).run();

    const err = await execOnServer(target(), { password: 'pw-db' }, 'uptime', 5_000).catch((e) => e);
    expect(err).toBeInstanceOf(HostKeyMismatchError);
    expect(err).toMatchObject({ serverId: targetId, expected: JUMP_FP, presented: TARGET_FP });

    const [jumpHop, targetHop] = state.connects;
    expect(targetHop.cfg.sock).toBe(state.forwards[0].channel);
    await flush();
    expect(state.ended.has(jumpHop.client)).toBe(true);
  });

  it('closes the jump connection when the jump host cannot reach the target', async () => {
    state.forwardError = 'Connection refused';

    const err = await execOnServer(target(), { password: 'pw-db' }, 'uptime', 5_000, undefined, {
      actorUserId: userId,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(JumpHostError);
    expect(err.message).toContain('could not reach 10.0.0.5:22');
    expect(state.connects).toHaveLength(1);
    expect(state.ended.has(state.connects[0].client)).toBe(true);
  });

  it('reports a jump host with no credentials without contacting anything', async () => {
    getDb().update(servers).set({ encryptedPassword: null }).where(eq(servers.id, jumpId)).run();

    const err = await execOnServer(target(), { password: 'pw-db' }, 'uptime', 5_000, undefined, {
      actorUserId: userId,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(JumpHostError);
    expect(err.message).toContain('Jump host bastion');
    expect(state.connects).toHaveLength(0);
  });

  it('aborts a jump that is still connecting when the caller gives up', async () => {
    state.hang.add('bastion.example');

    const err = await execOnServer(target(), { password: 'pw-db' }, 'uptime', 20).catch((e) => e);
    expect(err.message).toBe('Command timed out');
    // The target was never contacted, and the hop still handshaking is hung up on
    expect(state.connects).toHaveLength(1);
    expect(state.ended.has(state.connects[0].client)).toBe(true);
    await flush();
    expect(jumpAudits(jumpId)).toHaveLength(0);
  });

  it('closes a jump chain that finishes after the caller gave up', async () => {
    let finishForward: (() => void) | undefined;
    // Hold the forward until after the caller times out
    const Client = (await import('ssh2')).Client as any;
    const forwardOut = Client.prototype.forwardOut;
    Client.prototype.forwardOut = function (...args: any[]) {
      finishForward = () => forwardOut.apply(this, args);
    };
    try {
      const err = await execOnServer(target(), { password: 'pw-db' }, 'uptime', 20).catch((e) => e);
      expect(err.message).toBe('Command timed out');
      finishForward!();
      await flush();
      await flush();
      // The late tunnel is closed at once and the target is never contacted
      expect(state.connects).toHaveLength(1);
      expect(state.ended.has(state.connects[0].client)).toBe(true);
    } finally {
      Client.prototype.forwardOut = forwardOut;
    }
  });

  it('chains through two jump hosts, each verified over the previous channel', async () => {
    state.keys['edge.example'] = JUMP_KEY;
    const edgeId = await server('edge', 'edge.example');
    getDb().update(servers).set({ jumpServerId: edgeId }).where(eq(servers.id, jumpId)).run();

    await execOnServer(target(), { password: 'pw-db' }, 'uptime', 5_000);

    expect(state.connects.map((c: any) => c.cfg.host)).toEqual(['edge.example', 'bastion.example', '10.0.0.5']);
    expect(state.forwards.map((f: any) => `${f.host}:${f.port}`)).toEqual(['bastion.example:22', '10.0.0.5:22']);
    for (const { cfg } of state.connects) expect(typeof cfg.hostVerifier).toBe('function');
    expect(state.connects[0].cfg.sock).toBeUndefined();
    expect(state.connects[1].cfg.sock).toBe(state.forwards[0].channel);
    expect(state.connects[2].cfg.sock).toBe(state.forwards[1].channel);
    expect(state.connects.map((c: any) => c.cfg.password)).toEqual(['pw-edge', 'pw-bastion', 'pw-db']);

    await flush();
    for (const { client } of state.connects) expect(state.ended.has(client)).toBe(true);
    expect(jumpAudits(edgeId)).toHaveLength(1);
    expect(jumpAudits(jumpId)).toHaveLength(1);
  });

  it('refuses a looping chain without opening any connection', async () => {
    getDb().update(servers).set({ jumpServerId: targetId }).where(eq(servers.id, jumpId)).run();

    expect(() => jumpChain(targetId)).toThrow(/loops/);
    const err = await execOnServer(target(), { password: 'pw-db' }, 'uptime', 5_000).catch((e) => e);
    expect(err).toBeInstanceOf(JumpHostError);
    expect(state.connects).toHaveLength(0);
  });

  it(`refuses a chain longer than ${MAX_JUMP_DEPTH} hops`, async () => {
    let previous = jumpId;
    for (let i = 0; i < MAX_JUMP_DEPTH; i++) {
      const id = await server(`hop${i}`, `hop${i}.example`);
      getDb().update(servers).set({ jumpServerId: id }).where(eq(servers.id, previous)).run();
      previous = id;
    }
    expect(() => jumpChain(targetId)).toThrow(/longer than 3 hops/);
    const err = await execOnServer(target(), { password: 'pw-db' }, 'uptime', 5_000).catch((e) => e);
    expect(err).toBeInstanceOf(JumpHostError);
    expect(state.connects).toHaveLength(0);
  });

  it('a terminal session goes through the jump host and closing it closes the jump connection', async () => {
    const id = await SSHBroker.createSession({
      server: target(),
      password: 'pw-db',
      userId,
      orgId,
      cols: 80,
      rows: 24,
    });
    for (let i = 0; i < 5; i++) await flush();
    const { jumpHop, targetHop } = expectBothHopsVerified();
    expect(JSON.parse(jumpAudits(jumpId)[0]!.metadata!).via).toBe('terminal');

    await SSHBroker.close(id, { userId, orgId });
    await flush();
    expect(state.ended.has(targetHop.client)).toBe(true);
    expect(state.ended.has(jumpHop.client)).toBe(true);
  });

  it('the SFTP pool connects through the jump host', async () => {
    const key = sftp.poolKey(orgId, targetId, userId);
    const lease = await sftp.acquire(key, target(), { password: 'pw-db' }, userId);
    lease.release();
    const { jumpHop } = expectBothHopsVerified();
    expect(JSON.parse(jumpAudits(jumpId)[0]!.metadata!).via).toBe('sftp');

    sftp.evictServer(orgId, targetId);
    await flush();
    await flush();
    expect(state.ended.has(jumpHop.client)).toBe(true);
  });

  it('the health probe connects through the jump host without flooding the audit log', async () => {
    const result = await runProbe(target(), { password: 'pw-db' }, 5_000);
    expect(result.sample.hostname).toBe('fake');
    expectBothHopsVerified();
    expect(jumpAudits(jumpId)).toHaveLength(0);
  });

  it('a health check a user asked for audits the jump hop under them', async () => {
    const outcome = await checkServerById(orgId, targetId, userId);
    expect(outcome?.status).toBe('online');
    const [entry] = jumpAudits(jumpId);
    expect(entry).toMatchObject({ actorId: userId });
    expect(JSON.parse(entry!.metadata!)).toMatchObject({ targetId, via: 'health_check' });
  });

  it("a changed jump host key leaves the target unreachable, not with a host key mismatch of its own", async () => {
    getDb().update(servers).set(pinnedColumns(TARGET_FP, 'ssh-rsa', userId)).where(eq(servers.id, jumpId)).run();

    const outcome = await checkServerById(orgId, targetId);
    expect(outcome).toMatchObject({ serverId: targetId, status: 'error' });
    // A background sweep has no user to show details to: its error is stored
    // where every member who can see the target reads it
    expect(outcome?.error).toBe('The route to this server failed at hop 1');
    // The mismatch is recorded on the jump host only
    expect(row(jumpId).hostKeyMismatchFingerprint).toBe(JUMP_FP);
    expect(row(targetId).hostKeyMismatchFingerprint).toBeNull();
  });

  it('a host key scan reads the target key through the jump host, verifying the jump host', async () => {
    const scanned = await scanServerHostKey(target(), { actorUserId: userId });
    expect(scanned.fingerprint).toBe(TARGET_FP);

    const [jumpHop, scan] = state.connects;
    expect(jumpHop.cfg.host).toBe('bastion.example');
    expect(typeof jumpHop.cfg.hostVerifier).toBe('function');
    expect(row(jumpId).hostKeyFingerprint).toBe(JUMP_FP);
    expect(scan.cfg.sock).toBe(state.forwards[0].channel);
    // A scan stores nothing for the target
    expect(row(targetId).hostKeyFingerprint).toBeNull();
    await flush();
    expect(state.ended.has(jumpHop.client)).toBe(true);
  });

  it('a direct server connects without any jump', async () => {
    getDb().update(servers).set({ jumpServerId: null }).where(eq(servers.id, targetId)).run();
    await execOnServer(target(), { password: 'pw-db' }, 'uptime', 5_000);
    expect(state.connects).toHaveLength(1);
    expect(state.connects[0].cfg.sock).toBeUndefined();
    expect(state.forwards).toHaveLength(0);
  });
});

describe('jump host errors shown to users', () => {
  /** A restricted member granted the target only (plus `extra`). */
  function restrictedMember(extra: string[] = []) {
    const member = seedUser(orgId, 'member').userId;
    getDb()
      .update(memberships)
      .set({ serverAccess: 'restricted' })
      .where(and(eq(memberships.userId, member), eq(memberships.orgId, orgId)))
      .run();
    for (const serverId of [targetId, ...extra]) {
      getDb().insert(memberServerAccess).values({ orgId, userId: member, serverId }).run();
    }
    return member;
  }

  const run = (actorUserId?: string) =>
    execOnServer(target(), { password: 'pw-db' }, 'uptime', 5_000, undefined, { actorUserId }).catch((e) => e);

  it('hides the jump host from a member who cannot access it', async () => {
    state.forwardError = 'Connection refused';
    const err = await run(restrictedMember());
    expect(err).toBeInstanceOf(JumpHostError);
    expect(err.message).toBe('The route to this server failed at hop 1');
    expect(err.hop).toBe(1);
    expect(err.message).not.toMatch(/bastion|10\.0\.0\.5/);
  });

  it("hides a jump host's changed key (and its fingerprints) from such a member", async () => {
    getDb().update(servers).set(pinnedColumns(TARGET_FP, 'ssh-rsa', userId)).where(eq(servers.id, jumpId)).run();
    const err = await run(restrictedMember());
    expect(err).toBeInstanceOf(JumpHostError);
    expect(err).not.toBeInstanceOf(HostKeyMismatchError);
    expect(err.message).toBe('The route to this server failed at hop 1');
  });

  it('counts the failing hop from this app outwards', async () => {
    const outer = await server('outer', 'outer.example');
    state.keys['outer.example'] = JUMP_KEY;
    getDb().update(servers).set({ jumpServerId: outer }).where(eq(servers.id, jumpId)).run();
    getDb().update(servers).set({ encryptedPassword: null }).where(eq(servers.id, jumpId)).run();

    const err = await run(restrictedMember([outer]));
    expect(err.message).toBe('The route to this server failed at hop 2');
  });

  it('shows the details to a member granted the jump server, and to admins', async () => {
    state.forwardError = 'Connection refused';
    const granted = await run(restrictedMember([jumpId]));
    expect(granted.message).toContain('Jump host bastion could not reach 10.0.0.5:22');

    const admin = await run(userId);
    expect(admin.message).toContain('Jump host bastion could not reach 10.0.0.5:22');
  });

  it('keeps the details out of work that has no user', async () => {
    state.forwardError = 'Connection refused';
    const err = await run(undefined);
    expect(err.message).toBe('The route to this server failed at hop 1');
  });
});

describe('jump host validation', () => {
  it('rejects itself, unknown or foreign servers', async () => {
    expect(jumpHostProblem(orgId, jumpId, jumpId)).toMatch(/own jump host/);
    expect(jumpHostProblem(orgId, jumpId, 'nope')).toBe('Unknown jump host');
    const otherOrg = seedOrg('jump-hosts-other');
    const foreign = seedServer(otherOrg, userId, 'foreign');
    expect(jumpHostProblem(orgId, undefined, foreign)).toBe('Unknown jump host');
  });

  it('rejects a loop', () => {
    // bastion -> db would close db -> bastion -> db
    expect(jumpHostProblem(orgId, jumpId, targetId)).toMatch(/loop/);
  });

  it('counts hops both above and below the server being changed', async () => {
    // new -> db -> bastion: fine
    expect(jumpHostProblem(orgId, undefined, targetId)).toBeNull();
    const a = await server('a', 'a.example', targetId); // a -> db -> bastion (2 hops)
    expect(jumpHostProblem(orgId, undefined, a)).toBeNull(); // x -> a -> db -> bastion (3)
    const b = await server('b', 'b.example', a);
    expect(jumpHostProblem(orgId, undefined, b)).toMatch(/limited to 3 hops/);

    // Giving bastion a jump host of its own would push b to 4 hops
    const edge = await server('edge', 'edge.example');
    expect(jumpHostProblem(orgId, jumpId, edge)).toMatch(/limited to 3 hops/);
    expect(serversBehind(orgId, jumpId).sort()).toEqual([targetId, a, b].sort());
  });
});
