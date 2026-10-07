import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import https from 'node:https';

/**
 * Quick services (services spec §3.3, §3.4, §5) against a real server: a
 * throwaway `docker:dind` daemon and an `openssh-server` with the Docker CLI
 * sharing its socket and the deployments folder, as in
 * services.integration.test.ts, with the daemon's port 443 published on the
 * host's loopback so the proxy can be reached.
 *
 * 1. PostgreSQL, Redis, MongoDB and MinIO are created from the catalog
 *    through the API (the pinned images, generated secrets).
 * 2. An app container on bastion-apps connects to each with the credentials
 *    revealed through the API (passkey step-up session).
 * 3. PostgreSQL is backed up, changed, restored (the data is the backup's
 *    again, a pre-restore backup kept), and a backup is downloaded.
 * 4. A schedule makes bastion-cron take a scheduled backup by itself.
 * 5. Redis runs an older 8.x release, gets data, and Update version moves it
 *    to the pinned release (recreate) with the data kept.
 * 6. MinIO's console answers through Caddy on its domain with tls internal.
 * 7. The rest of the catalog is created (MySQL, MariaDB, Valkey, Memcached,
 *    RabbitMQ, Meilisearch, ClickHouse, Mailpit, Adminer, Grafana, Uptime
 *    Kuma) and each is used as an app would: a client on bastion-apps with
 *    the revealed credentials, or its UI through Caddy (tls internal).
 * 8. MySQL, MariaDB, Valkey, Redis and MongoDB are backed up, changed and
 *    restored, and the backup's data is there again.
 * 9. SeaweedFS from the catalog: an app on bastion-apps creates a bucket and
 *    puts and gets an object with SigV4 and the revealed keys, a wrong key
 *    and an anonymous request are refused, only the S3 port is reachable,
 *    no key is on a command line, the S3 API answers through Caddy on its
 *    domain, and the data survives a recreate redeploy.
 * 10. Grafana created on 12 and updated to 13: a rollback to the 12 release
 *    is refused (409 line_change_refused, and by bastionctl itself on the
 *    server), a rollback within 13 is allowed.
 *
 * Steps 9 and 10 run on their own too: `-t 'SeaweedFS|version line'`.
 *
 *   docker network create bastion-qs-net
 *   docker volume create bastion-qs-sock && docker volume create bastion-qs-root
 *   docker run -d --rm --privileged --name bastion-qs-dind --network bastion-qs-net -e DOCKER_TLS_CERTDIR= \
 *     -p 127.0.0.1:28643:443 -v bastion-qs-sock:/var/run -v bastion-qs-root:/config/bastion docker:dind
 *   docker run -d --rm --name bastion-qs-sshd --network bastion-qs-net -p 127.0.0.1:22722:2222 \
 *     -e USER_NAME=smt -e USER_PASSWORD=bastion-it-pass -e PASSWORD_ACCESS=true -e PUID=1000 -e PGID=1000 \
 *     -v bastion-qs-sock:/sock -v bastion-qs-root:/config/bastion lscr.io/linuxserver/openssh-server
 *   docker exec bastion-qs-dind sh -c 'until [ -S /var/run/docker.sock ]; do sleep 1; done; chmod 666 /var/run/docker.sock; chown 1000:1000 /config/bastion'
 *   docker exec bastion-qs-sshd sh -c 'apk add --no-cache docker-cli && ln -sf /sock/docker.sock /var/run/docker.sock'
 *
 *   SMT_TEST_QUICK_SSH_PORT=22722 pnpm vitest run src/deploy/quick-services.integration.test.ts
 *
 *   docker stop bastion-qs-sshd bastion-qs-dind && docker volume rm bastion-qs-sock bastion-qs-root && docker network rm bastion-qs-net
 */

const port = Number(process.env.SMT_TEST_QUICK_SSH_PORT ?? 0);
const SSHD = process.env.SMT_TEST_QUICK_SSHD ?? 'bastion-qs-sshd';
const HTTPS_PORT = Number(process.env.SMT_TEST_QUICK_HTTPS_PORT ?? 28643);
const ROOT = '/config/bastion';
/** An older Redis 8 release than the catalog pins (Update version moves it up). */
const REDIS_OLD = 'redis:8.2.8-alpine@sha256:a7859ed111db3c1f5404a973a4747505d559fb5ca32d37e447afc0ef845a2103';

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { seedOrg, seedSession, seedUser } = await import('../api/routes/test-utils.js');
const { getDb } = await import('../db/index.js');
const { auditLog, passkeys, sessions } = await import('../db/schema.js');
const { eq } = await import('drizzle-orm');
const { nanoid } = await import('nanoid');
const { serviceTemplate, serviceVersion } = await import('@smt/shared');

/** A shell command in the SSH server's container, as the SSH user (its Docker CLI talks to the throwaway daemon). */
function sh(command: string): string {
  return execFileSync('docker', ['exec', '-u', '1000', '-e', 'HOME=/tmp', SSHD, 'sh', '-c', command], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Single-quote for the shell. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** An HTTPS request to the throwaway daemon's port 443 (Caddy), for `host`, certificate not checked (tls internal). */
function viaProxy(host: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port: HTTPS_PORT, path, method: opts.method ?? 'GET', servername: host, headers: { host, ...opts.headers }, rejectUnauthorized: false, timeout: 15_000 },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString('utf8')));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Retry `viaProxy` until `ok` (the certificate is issued and the route applied a moment after the deploy). */
async function untilProxy(host: string, path: string, ok: (r: { status: number; body: string }) => boolean, opts: Parameters<typeof viaProxy>[2] = {}, ms = 90_000) {
  const started = Date.now();
  let last: { status: number; body: string; headers: Record<string, unknown> } = { status: 0, body: '', headers: {} };
  while (Date.now() - started < ms) {
    try {
      last = await viaProxy(host, path, opts);
      if (ok(last)) return last;
    } catch (err) {
      last = { status: 0, body: (err as Error).message, headers: {} };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

describe.skipIf(!port)('quick services against a live server', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let admin: ReturnType<typeof seedUser>;
  let browser: { headers: Record<string, string> };
  let serverId: string;
  const report: Record<string, unknown> = {};
  const created: string[] = [];

  const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = admin.headers) =>
    app.inject({ method, url, headers, ...(payload && { payload }) });
  const deployApi = (p = '') => `/api/deploy/servers/${serverId}${p}`;
  const audits = (action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, action))
      .all()
      .map((r) => JSON.parse(r.metadata ?? '{}') as Record<string, unknown>);

  async function stream(url: string, body: unknown): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`${base}${url}`, { method: 'POST', headers: { ...admin.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    expect(res.headers.get('content-type'), text).toBe('text/event-stream');
    return text
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
  }
  const outcomeOf = (events: Array<Record<string, unknown>>) => (events.find((e) => e.type === 'result') as { outcome: { result: string; release: string; error: string | null } } | undefined)?.outcome;
  const logOf = (events: Array<Record<string, unknown>>) =>
    events
      .filter((e) => e.type === 'log' || e.type === 'error')
      .flatMap((e) => (e.type === 'error' ? [`error: ${e.error as string}`] : (e.lines as Array<{ text: string }>).map((l) => l.text)))
      .join('\n');

  async function create(body: Record<string, unknown>) {
    const started = Date.now();
    const events = await stream(deployApi('/services'), body);
    const outcome = outcomeOf(events);
    expect(outcome?.result, logOf(events)).toBe('success');
    created.push(body.name as string);
    return { events, outcome: outcome!, ms: Date.now() - started };
  }

  /** The connection string with its secrets revealed through the API, as the Connection panel does. */
  async function connection(name: string, label = 'URL') {
    const res = await api('GET', deployApi(`/apps/${name}/connection`));
    expect(res.statusCode, res.body).toBe(200);
    const conn = res.json() as { strings: Array<{ label: string; internal: string }>; secrets: string[]; fields: Array<{ label: string; value: string | null; secret: string | null }> };
    const values: Record<string, string> = {};
    for (const key of conn.secrets) {
      const reveal = await api('POST', deployApi(`/apps/${name}/env/${key}/reveal`), undefined, browser.headers);
      expect(reveal.statusCode, reveal.body).toBe(200);
      values[key] = (reveal.json() as { value: string }).value;
    }
    const fill = (t: string) => t.replace(/\{([A-Z_]+)\}/g, (_m, k: string) => values[k]!);
    const string = conn.strings.find((s) => s.label === label);
    return { url: string ? fill(string.internal) : '', values, conn };
  }

  /** A throwaway client container on bastion-apps, like an app deployed on the server. */
  const client = (image: string, args: string) => sh(`docker run --rm --network bastion-apps ${image} ${args}`).trim();

  beforeAll(async () => {
    await runMigrations();
    const orgId = seedOrg('quick-services-it');
    admin = seedUser(orgId, 'admin');
    // A browser session that has just confirmed a passkey: what reveals and downloads need
    const session = await seedSession(admin.userId);
    getDb().insert(passkeys).values({ id: nanoid(), userId: admin.userId, credentialId: nanoid(), publicKey: Buffer.from([1]), deviceType: 'multiDevice', name: 'it' }).run();
    getDb().update(sessions).set({ passkeyVerified: true }).where(eq(sessions.id, session.sessionId)).run();
    browser = session;
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const res = await api('POST', '/api/servers', { name: 'quick-services-it', host: '127.0.0.1', port, username: 'smt', authType: 'password', password: 'bastion-it-pass' });
    expect(res.statusCode, res.body).toBe(201);
    serverId = res.json().id;
    const setup = await api('POST', deployApi('/setup'), { proxy: 'caddy' });
    expect(setup.statusCode, setup.body).toBe(200);
  }, 600_000);

  afterAll(async () => {
    if (serverId && !process.env.SMT_TEST_KEEP) {
      for (const name of created) await api('DELETE', deployApi(`/apps/${name}?purge=true`)).catch(() => {});
      report.cronAfterCleanup = sh(`docker ps -a --filter name=bastion-cron --format '{{.Names}}'`).trim() || 'removed';
    }
    await app?.close();
    console.log(`quick services live report: ${JSON.stringify(report, null, 2)}`);
    // Seventeen services deleted with their data, one SSH command each: well past the 10 s default
  }, 300_000);

  it('creates PostgreSQL, Redis, MongoDB and MinIO from the catalog, with secrets generated on the server', async () => {
    const pg = await create({ name: 'orders-db', template: 'postgres', version: '17' });
    expect(logOf(pg.events)).toContain('Generated POSTGRES_PASSWORD on the server (24 random bytes)');
    const redis = await create({ name: 'cache', template: 'redis' });
    const mongo = await create({ name: 'events-db', template: 'mongodb' });
    const minio = await create({ name: 'files', template: 'minio', domain: 'minio.test', tls: 'internal' });
    report.createMs = { postgres: pg.ms, redis: redis.ms, mongodb: mongo.ms, minio: minio.ms };
    const rows = audits('deploy.service_create');
    expect(rows.map((a) => a.template).sort()).toEqual(['minio', 'mongodb', 'postgres', 'redis']);
    // The images are the catalog's, by digest
    for (const [name, id] of [['orders-db', 'postgres'], ['cache', 'redis'], ['events-db', 'mongodb'], ['files', 'minio']] as const) {
      const releases = (await api('GET', deployApi(`/apps/${name}/releases`))).json() as Array<{ digest: string }>;
      const t = serviceTemplate(id)!;
      const pinned = t.versions.find((v) => v.default)!.image;
      expect(pinned.endsWith(releases[0]!.digest), `${name}: ${pinned} vs ${releases[0]!.digest}`).toBe(true);
    }
    // Nothing published: only bastion-apps reaches them
    expect(sh(`docker ps --filter label=bastion.managed=app --format '{{.Names}} {{.Ports}}'`)).not.toMatch(/0\.0\.0\.0/);
  }, 1_800_000);

  it('lets an app on bastion-apps connect to each with the revealed credentials', async () => {
    const pg = await connection('orders-db');
    expect(pg.url).toMatch(/^postgres:\/\/app:[A-Za-z0-9_-]{32}@orders-db:5432\/app$/);
    const pgImage = serviceVersion(serviceTemplate('postgres')!, '17')!.image;
    expect(client(pgImage, `psql ${q(pg.url)} -qtAc "create table orders (id int primary key, item text); insert into orders values (1, 'book'); select count(*) from orders"`)).toBe('1');
    expect(() => client(pgImage, `psql ${q(pg.url.replace(pg.values.POSTGRES_PASSWORD!, 'wrong'))} -tAc "select 1"`)).toThrow();

    const redis = await connection('cache');
    const redisImage = serviceTemplate('redis')!.versions[0]!.image;
    expect(client(redisImage, `redis-cli -u ${q(redis.url)} --no-auth-warning set greeting hello`)).toBe('OK');
    expect(client(redisImage, `redis-cli -u ${q(redis.url)} --no-auth-warning get greeting`)).toBe('hello');
    expect(client(`--entrypoint sh ${redisImage}`, `-c ${q('redis-cli -h cache ping 2>&1 || true')}`)).toContain('NOAUTH');

    const mongo = await connection('events-db');
    const mongoImage = serviceTemplate('mongodb')!.versions[0]!.image;
    expect(client(mongoImage, `mongosh ${q(mongo.url)} --quiet --eval ${q("db.getSiblingDB('shop').orders.insertOne({ item: 'pen' }); print(db.getSiblingDB('shop').orders.countDocuments())")}`)).toBe('1');

    const minio = await connection('files', 'S3 endpoint');
    expect(minio.url).toBe('http://files:9000');
    const secret = minio.values.MINIO_ROOT_PASSWORD!;
    const s3 = (args: string) => client('curlimages/curl:8.16.0', `-sS -f --aws-sigv4 aws:amz:us-east-1:s3 --user ${q(`admin:${secret}`)} ${args}`);
    s3('-X PUT http://files:9000/uploads');
    s3('-X PUT --data-binary hello http://files:9000/uploads/hello.txt');
    expect(s3('http://files:9000/uploads/hello.txt')).toBe('hello');
    expect(() => client('curlimages/curl:8.16.0', `-sS -f --aws-sigv4 aws:amz:us-east-1:s3 --user admin:wrong http://files:9000/uploads/hello.txt`)).toThrow();
    report.connected = ['postgres', 'redis', 'mongodb', 'minio'];
    // Reveals are audited by name, never with the value
    expect(JSON.stringify(audits('deploy.env_reveal'))).not.toContain(pg.values.POSTGRES_PASSWORD!);
  }, 900_000);

  it('backs PostgreSQL up, restores it, and downloads a backup', async () => {
    const pg = await connection('orders-db');
    const pgImage = serviceVersion(serviceTemplate('postgres')!, '17')!.image;
    const psql = (sql: string) => client(pgImage, `psql ${q(pg.url)} -qtAc ${q(sql)}`);
    const made = await api('POST', deployApi('/apps/orders-db/backups'));
    expect(made.statusCode, made.body).toBe(200);
    const backup = (made.json() as { backup: { file: string; bytes: number } }).backup;
    expect(backup.file).toMatch(/^\d{8}T\d{6}Z\.dump$/);
    expect(sh(`stat -c '%a %s' ${ROOT}/apps/orders-db/backups/${backup.file}`).trim()).toBe(`600 ${backup.bytes}`);

    // Change the data, then restore: the backup's rows again, the changed data kept as pre-restore
    psql("insert into orders values (2, 'lamp'); delete from orders where id = 1");
    expect(psql('select item from orders order by id')).toBe('lamp');
    const restored = await api('POST', deployApi(`/apps/orders-db/backups/${backup.file}/restore`), { confirm: 'orders-db' });
    expect(restored.statusCode, restored.body).toBe(200);
    const result = restored.json() as { safety: { file: string }; method: string };
    expect(result.method).toBe('exec');
    expect(psql('select item from orders order by id')).toBe('book');
    const list = (await api('GET', deployApi('/apps/orders-db/backups'))).json() as { backups: Array<{ file: string; kind: string }> };
    expect(list.backups.map((b) => b.kind).sort()).toEqual(['manual', 'pre-restore']);
    expect(list.backups.find((b) => b.kind === 'pre-restore')!.file).toBe(result.safety.file);

    const download = await api('GET', deployApi(`/apps/orders-db/backups/${backup.file}`), undefined, browser.headers);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.length).toBe(backup.bytes);
    expect(download.rawPayload.subarray(0, 5).toString('latin1')).toBe('PGDMP');
    expect(audits('deploy.backup_download').at(-1)).toMatchObject({ app: 'orders-db', file: backup.file, bytes: backup.bytes });
    report.postgresBackup = { file: backup.file, bytes: backup.bytes, restored: true, safety: result.safety.file };
  }, 600_000);

  it('has bastion-cron take a scheduled backup by itself', async () => {
    // No backup left: the schedule is due at once
    const list = (await api('GET', deployApi('/apps/orders-db/backups'))).json() as { backups: Array<{ file: string }> };
    for (const b of list.backups) expect((await api('DELETE', deployApi(`/apps/orders-db/backups/${b.file}`))).statusCode).toBe(200);
    const res = await api('PUT', deployApi('/apps/orders-db/backups/schedule'), { schedule: 'hourly', keep: 3 });
    expect(res.statusCode, res.body).toBe(200);
    expect(sh(`docker inspect -f '{{.State.Status}} {{.HostConfig.NetworkMode}} {{.Config.User}}' bastion-cron`).trim()).toBe('running none 1000:1000');
    const started = Date.now();
    let scheduled: { file: string } | undefined;
    while (!scheduled && Date.now() - started < 150_000) {
      await new Promise((r) => setTimeout(r, 5000));
      scheduled = ((await api('GET', deployApi('/apps/orders-db/backups'))).json() as { backups: Array<{ file: string; kind: string }> }).backups.find((b) => b.kind === 'scheduled');
    }
    expect(scheduled, sh('docker logs --tail 20 bastion-cron 2>&1')).toBeDefined();
    const after = (await api('GET', deployApi('/apps/orders-db/backups'))).json() as { lastScheduled: { result: string; file: string } };
    expect(after.lastScheduled).toMatchObject({ result: 'success', file: scheduled!.file });
    report.scheduledBackup = { file: scheduled!.file, afterMs: Date.now() - started };
  }, 300_000);

  it('updates Redis within its major (recreate), keeping its data', async () => {
    // As if created by an older BastionSSH: a service of its own on an older 8.x release
    // (an RDB written by a newer Redis does not load into an older one, so not the cache above)
    const config = (await api('GET', deployApi('/apps/cache/config'))).json() as { text: string };
    const pinned = serviceTemplate('redis')!.versions.find((v) => v.major === '8')!.image;
    const old = config.text.replace(pinned, REDIS_OLD).replace('name: cache', 'name: sessions');
    expect(old).toContain(REDIS_OLD);
    const saved = await api('PUT', deployApi('/apps/sessions/config'), { text: old });
    expect(saved.statusCode, saved.body).toBe(200);
    created.push('sessions');
    expect((await api('POST', deployApi('/apps/sessions/env/REDIS_PASSWORD/generate'), { bytes: 24, ifMissing: true })).statusCode).toBe(200);
    const redeployed = await stream(deployApi('/apps/sessions/deploy'), {});
    expect(outcomeOf(redeployed)?.result, logOf(redeployed)).toBe('success');
    const redis = await connection('sessions');
    const cli = (args: string) => client(pinned, `redis-cli -u ${q(redis.url)} --no-auth-warning ${args}`);
    expect(cli('info server')).toContain('redis_version:8.2.8');
    expect(cli('set kept-across-update yes')).toBe('OK');

    const events = await stream(deployApi('/apps/sessions/service/version'), { version: '8' });
    expect(outcomeOf(events)?.result, logOf(events)).toBe('success');
    expect(logOf(events)).toContain('before the new container starts (volume data is exclusive)');
    expect(cli('info server')).toMatch(new RegExp(`redis_version:${serviceTemplate('redis')!.versions[0]!.version.replace(/-alpine$/, '').replace(/\./g, '\\.')}`));
    expect(cli('get kept-across-update')).toBe('yes');
    expect(audits('deploy.service_update').at(-1)).toMatchObject({ app: 'sessions', from: REDIS_OLD, to: pinned });
    const containers = sh(`docker ps -a --filter label=bastion.app=sessions --format '{{.Names}} {{.State}}'`).trim().split('\n');
    expect(containers).toHaveLength(1);

    // A major change is refused
    const refused = await api('POST', deployApi('/apps/sessions/service/version'), { version: '7' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('major_upgrade_refused');
    report.redisUpdate = { from: REDIS_OLD, to: pinned, dataKept: true };
  }, 900_000);

  it('serves the MinIO console through Caddy on its domain, with tls internal', async () => {
    const started = Date.now();
    let status = 0;
    let body = '';
    while (Date.now() - started < 60_000) {
      try {
        ({ status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = https.request(
            { host: '127.0.0.1', port: HTTPS_PORT, path: '/', servername: 'minio.test', headers: { host: 'minio.test' }, rejectUnauthorized: false, timeout: 10_000 },
            (res) => {
              let text = '';
              res.on('data', (c: Buffer) => (text += c.toString('utf8')));
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
            },
          );
          req.on('error', reject);
          req.end();
        }));
        if (status === 200) break;
      } catch {
        // the certificate is being issued
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(status, body.slice(0, 300)).toBe(200);
    expect(body).toMatch(/<html/i);
    // The console's own API answers behind the same domain
    const login = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = https.request(
        { host: '127.0.0.1', port: HTTPS_PORT, path: '/api/v1/login', servername: 'minio.test', headers: { host: 'minio.test' }, rejectUnauthorized: false, timeout: 10_000 },
        (res) => {
          let text = '';
          res.on('data', (c: Buffer) => (text += c.toString('utf8')));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(login.status, login.body).toBe(200);
    expect(login.body).toContain('loginStrategy');
    const connection = (await api('GET', deployApi('/apps/files/connection'))).json() as { ui: { urls: string[] } };
    expect(connection.ui.urls).toEqual(['https://minio.test']);
    report.minioConsole = { status, title: /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? null, login: login.body.slice(0, 120) };
  }, 120_000);
  // ── The rest of the catalog ────────────────────────────────────────────────

  /** The pinned default image of a template. */
  const imageOf = (id: string) => serviceTemplate(id)!.versions.find((v) => v.default)!.image;
  /** Back up `name` through the API (manage), returning the file. */
  async function backupNow(name: string) {
    const made = await api('POST', deployApi(`/apps/${name}/backups`));
    expect(made.statusCode, made.body).toBe(200);
    const b = (made.json() as { backup: { file: string; bytes: number } }).backup;
    expect(sh(`stat -c '%a' ${ROOT}/apps/${name}/backups/${b.file}`).trim()).toBe('600');
    return b;
  }
  async function restoreNow(name: string, file: string) {
    const res = await api('POST', deployApi(`/apps/${name}/backups/${file}/restore`), { confirm: name });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { method: string; safety: { file: string } };
  }

  it('creates MySQL, MariaDB, Valkey, Memcached, RabbitMQ, Meilisearch, ClickHouse, Mailpit, Adminer, Grafana and Uptime Kuma', async () => {
    const plan: Array<Record<string, unknown>> = [
      { name: 'shop-mysql', template: 'mysql' },
      { name: 'shop-maria', template: 'mariadb' },
      { name: 'kv', template: 'valkey' },
      { name: 'memo', template: 'memcached' },
      { name: 'mq', template: 'rabbitmq', domain: 'rabbit.test', tls: 'internal' },
      { name: 'search', template: 'meilisearch', domain: 'search.test', tls: 'internal' },
      { name: 'olap', template: 'clickhouse' },
      { name: 'mail', template: 'mailpit', domain: 'mail.test', tls: 'internal' },
      { name: 'dbadmin', template: 'adminer', domain: 'adminer.test', tls: 'internal' },
      { name: 'dash', template: 'grafana', domain: 'grafana.test', tls: 'internal' },
      { name: 'uptime', template: 'uptime-kuma', domain: 'kuma.test', tls: 'internal' },
    ];
    const ms: Record<string, number> = {};
    for (const body of plan) ms[body.template as string] = (await create(body)).ms;
    report.createMs2 = ms;
    for (const body of plan) {
      const releases = (await api('GET', deployApi(`/apps/${body.name as string}/releases`))).json() as Array<{ digest: string }>;
      expect(imageOf(body.template as string).endsWith(releases[0]!.digest)).toBe(true);
      // Healthy, one container
      const ps = sh(`docker ps -a --filter label=bastion.app=${body.name as string} --format '{{.Status}}'`).trim().split('\n');
      expect(ps, `${body.name as string}: ${ps.join(' | ')}`).toHaveLength(1);
      expect(ps[0]).toMatch(/^Up /);
    }
    expect(sh(`docker ps --filter label=bastion.managed=app --format '{{.Names}} {{.Ports}}'`)).not.toMatch(/0\.0\.0\.0/);
  }, 3_600_000);

  it('connects to MySQL, backs it up, restores it', async () => {
    const { url } = await connection('shop-mysql');
    const u = new URL(url);
    expect(u.hostname).toBe('shop-mysql');
    const img = imageOf('mysql');
    const sql = (s: string) => client(`-e MYSQL_PWD=${q(decodeURIComponent(u.password))} --entrypoint mysql ${img}`, `-h shop-mysql -u ${u.username} -N -B ${u.pathname.slice(1)} -e ${q(s)}`);
    sql("create table orders (id int primary key, item text); insert into orders values (1, 'book')");
    expect(sql('select item from orders')).toBe('book');
    expect(() => client(`-e MYSQL_PWD=wrong --entrypoint mysql ${img}`, `-h shop-mysql -u app app -e 'select 1'`)).toThrow();
    const b = await backupNow('shop-mysql');
    expect(b.file).toMatch(/\.sql$/);
    sql("insert into orders values (2, 'lamp'); delete from orders where id = 1");
    expect(sql('select item from orders')).toBe('lamp');
    const r = await restoreNow('shop-mysql', b.file);
    expect(r.method).toBe('exec');
    expect(sql('select item from orders order by id')).toBe('book');
    report.mysql = { connected: true, backup: b, restored: true, safety: r.safety.file };
  }, 600_000);

  it('connects to MariaDB, backs it up, restores it', async () => {
    const { url } = await connection('shop-maria');
    const u = new URL(url);
    const img = imageOf('mariadb');
    const sql = (s: string) => client(`-e MYSQL_PWD=${q(decodeURIComponent(u.password))} --entrypoint mariadb ${img}`, `-h shop-maria -u ${u.username} -N -B ${u.pathname.slice(1)} -e ${q(s)}`);
    sql("create table orders (id int primary key, item text); insert into orders values (1, 'book')");
    expect(sql('select item from orders')).toBe('book');
    const b = await backupNow('shop-maria');
    sql("insert into orders values (2, 'lamp'); delete from orders where id = 1");
    const r = await restoreNow('shop-maria', b.file);
    expect(sql('select item from orders order by id')).toBe('book');
    report.mariadb = { connected: true, backup: b, restored: true, safety: r.safety.file };
  }, 600_000);

  it('connects to Valkey, backs it up, restores it (replace-file)', async () => {
    const { url } = await connection('kv');
    expect(url).toMatch(/^redis:\/\/default:[A-Za-z0-9_-]{32}@kv:6379\/0$/);
    const cli = (args: string) => client(`--entrypoint valkey-cli ${imageOf('valkey')}`, `-u ${q(url)} --no-auth-warning ${args}`);
    expect(cli('set greeting hello')).toBe('OK');
    const b = await backupNow('kv');
    expect(b.file).toMatch(/\.rdb$/);
    expect(cli('set greeting changed')).toBe('OK');
    expect(cli('set extra 1')).toBe('OK');
    const r = await restoreNow('kv', b.file);
    expect(r.method).toBe('replace-file');
    expect(cli('get greeting')).toBe('hello');
    expect(cli('exists extra')).toBe('0');
    report.valkey = { connected: true, backup: b, restored: true };
  }, 600_000);

  it('restores Redis and MongoDB backups', async () => {
    const redis = await connection('cache');
    const rcli = (args: string) => client(imageOf('redis'), `redis-cli -u ${q(redis.url)} --no-auth-warning ${args}`);
    expect(rcli('set greeting before-backup')).toBe('OK');
    const rb = await backupNow('cache');
    expect(rcli('set greeting after-backup')).toBe('OK');
    expect((await restoreNow('cache', rb.file)).method).toBe('replace-file');
    expect(rcli('get greeting')).toBe('before-backup');

    const mongo = await connection('events-db');
    const msh = (js: string) => client(imageOf('mongodb'), `mongosh ${q(mongo.url)} --quiet --eval ${q(js)}`);
    msh("db.getSiblingDB('shop').orders.deleteMany({}); db.getSiblingDB('shop').orders.insertOne({ item: 'book' })");
    const mb = await backupNow('events-db');
    expect(mb.file).toMatch(/\.archive\.gz$/);
    msh("db.getSiblingDB('shop').orders.deleteMany({}); db.getSiblingDB('shop').orders.insertOne({ item: 'lamp' }); db.getSiblingDB('shop').extra.insertOne({ x: 1 })");
    expect((await restoreNow('events-db', mb.file)).method).toBe('exec');
    expect(msh("print(db.getSiblingDB('shop').orders.find().toArray().map(d => d.item).join(','))")).toBe('book');
    report.redisRestore = { backup: rb, restored: true };
    report.mongoRestore = { backup: mb, restored: true };
  }, 600_000);

  it('connects to Memcached, ClickHouse and Meilisearch', async () => {
    const memo = await connection('memo', 'Server');
    expect(memo.url).toBe('memo:11211');
    const out = client(`--entrypoint sh ${imageOf('memcached')}`, `-c ${q("printf 'set k 0 0 5\\r\\nhello\\r\\nget k\\r\\nquit\\r\\n' | nc memo 11211")}`);
    expect(out).toContain('STORED');
    expect(out).toContain('hello');

    const ch = await connection('olap', 'HTTP URL');
    const chu = new URL(ch.url);
    expect(chu.host).toBe('olap:8123');
    const curl = (args: string) => client('curlimages/curl:8.16.0', `-sS -f ${args}`);
    const auth = `--user ${q(`${chu.username}:${decodeURIComponent(chu.password)}`)}`;
    curl(`${auth} --data-binary ${q('create table events (id UInt32, name String) engine = MergeTree order by id')} 'http://olap:8123/?database=app'`);
    curl(`${auth} --data-binary ${q("insert into events values (1, 'signup')")} 'http://olap:8123/?database=app'`);
    expect(curl(`${auth} --data-binary 'select name from events' 'http://olap:8123/?database=app'`)).toBe('signup');
    expect(() => curl(`--user app:wrong --data-binary 'select 1' http://olap:8123/`)).toThrow();
    const native = await connection('olap', 'Native');
    const nu = new URL(native.url);
    expect(nu.port).toBe('9000');
    expect(client(`--entrypoint clickhouse-client ${imageOf('clickhouse')}`, `--host olap --port 9000 --user app --password ${q(decodeURIComponent(nu.password))} --database app --query 'select count() from events'`)).toBe('1');

    const meili = await connection('search');
    expect(meili.url).toBe('http://search:7700');
    const key = meili.values.MEILI_MASTER_KEY!;
    const bearer = `-H ${q(`Authorization: Bearer ${key}`)} -H 'Content-Type: application/json'`;
    curl(`${bearer} -X POST --data ${q('[{"id":1,"title":"Carol"},{"id":2,"title":"Wonder"}]')} http://search:7700/indexes/movies/documents`);
    let hits = '';
    for (let i = 0; i < 30 && !hits.includes('Carol'); i++) {
      hits = curl(`${bearer} -X POST --data '{"q":"carlo"}' http://search:7700/indexes/movies/search`);
      if (!hits.includes('Carol')) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(hits).toContain('Carol');
    expect(() => curl('http://search:7700/indexes')).toThrow();
    // Through Caddy on its domain
    const health = await untilProxy('search.test', '/health', (r) => r.status === 200);
    expect(health.status, health.body).toBe(200);
    expect((await viaProxy('search.test', '/indexes')).status).toBe(401);
    report.memcached = { connected: true };
    report.clickhouse = { http: true, native: true };
    report.meilisearch = { connected: true, typoSearch: true, viaProxy: health.status };
  }, 600_000);

  it('connects to RabbitMQ over AMQP and its management UI through Caddy', async () => {
    const mq = await connection('mq', 'AMQP URL');
    const u = new URL(mq.url);
    expect(u.host).toBe('mq:5672');
    const pass = decodeURIComponent(u.password);
    // The AMQP 0-9-1 protocol header: the broker answers with Connection.Start, naming its mechanisms
    const start = client(`--entrypoint sh ${imageOf('memcached')}`, `-c ${q("printf 'AMQP\\000\\000\\011\\001' | nc -w 3 mq 5672 | grep -ao 'PLAIN' | head -1")}`);
    expect(start).toContain('PLAIN');
    const curl = (args: string) => client('curlimages/curl:8.16.0', `-sS -f ${args}`);
    expect(curl(`--user ${q(`app:${pass}`)} http://mq:15672/api/whoami`)).toContain('"name":"app"');
    const published = curl(`--user ${q(`app:${pass}`)} -H 'content-type: application/json' -X POST --data ${q('{"properties":{},"routing_key":"nowhere","payload":"hi","payload_encoding":"string"}')} http://mq:15672/api/exchanges/%2F/amq.default/publish`);
    expect(published).toContain('routed');
    const ui = await untilProxy('rabbit.test', '/', (r) => r.status === 200);
    expect(ui.status, ui.body.slice(0, 200)).toBe(200);
    expect(ui.body).toMatch(/RabbitMQ/i);
    const authed = await viaProxy('rabbit.test', '/api/whoami', { headers: { authorization: `Basic ${Buffer.from(`app:${pass}`).toString('base64')}` } });
    expect(authed.status, authed.body).toBe(200);
    expect((await viaProxy('rabbit.test', '/api/whoami', { headers: { authorization: `Basic ${Buffer.from('app:wrong').toString('base64')}` } })).status).toBe(401);
    report.rabbitmq = { amqp: true, managementUi: ui.status, api: authed.status };
  }, 600_000);

  it('catches mail in Mailpit, its UI behind the generated password', async () => {
    const mail = await connection('mail', 'SMTP');
    expect(mail.url).toBe('smtp://mail:1025');
    const pass = mail.values.MAILPIT_UI_PASSWORD!;
    expect(pass).toMatch(/^[A-Za-z0-9_-]{24}$/);
    client('--entrypoint sh curlimages/curl:8.16.0', `-c ${q("printf 'Subject: bastion-it\\r\\n\\r\\nhello\\r\\n' | curl -sS -f smtp://mail:1025 --mail-from app@example.com --mail-rcpt ops@example.com -T -")}`);
    const basic = `Basic ${Buffer.from(`admin:${pass}`).toString('base64')}`;
    const list = await untilProxy('mail.test', '/api/v1/messages', (r) => r.status === 200 && r.body.includes('bastion-it'), { headers: { authorization: basic } });
    expect(list.status, list.body.slice(0, 200)).toBe(200);
    expect(list.body).toContain('bastion-it');
    expect((await viaProxy('mail.test', '/api/v1/messages')).status).toBe(401);
    expect((await viaProxy('mail.test', '/api/v1/messages', { headers: { authorization: `Basic ${Buffer.from('admin:wrong').toString('base64')}` } })).status).toBe(401);
    // The password is never on the container's command line
    expect(sh(`docker inspect -f '{{json .Config.Cmd}} {{json .Config.Entrypoint}}' $(docker ps -q --filter label=bastion.app=mail)`)).not.toContain(pass);
    report.mailpit = { smtp: true, ui: list.status, unauthenticated: 401 };
  }, 300_000);

  it('serves Adminer, Grafana and Uptime Kuma through Caddy', async () => {
    const adminer = await untilProxy('adminer.test', '/', (r) => r.status === 200);
    expect(adminer.status).toBe(200);
    expect(adminer.body).toContain('Adminer');
    // Adminer logs in to MySQL on bastion-apps
    const my = await connection('shop-mysql');
    const u = new URL(my.url);
    const login = client(
      '--entrypoint sh curlimages/curl:8.16.0',
      `-c ${q(`curl -sS -c /tmp/j -b /tmp/j -o /dev/null http://dbadmin:8080/ && curl -sS -c /tmp/j -b /tmp/j -L --data-urlencode 'auth[driver]=server' --data-urlencode 'auth[server]=shop-mysql' --data-urlencode 'auth[username]=app' --data-urlencode 'auth[password]=${decodeURIComponent(u.password)}' --data-urlencode 'auth[db]=app' 'http://dbadmin:8080/'`)}`,
    );
    expect(login).toContain('orders');

    const grafana = await untilProxy('grafana.test', '/api/health', (r) => r.status === 200);
    expect(grafana.status, grafana.body).toBe(200);
    const g = await connection('dash');
    const gpass = g.values.GF_SECURITY_ADMIN_PASSWORD!;
    const user = await viaProxy('grafana.test', '/api/user', { headers: { authorization: `Basic ${Buffer.from(`admin:${gpass}`).toString('base64')}` } });
    expect(user.status, user.body).toBe(200);
    expect(user.body).toContain('"login":"admin"');
    expect((await viaProxy('grafana.test', '/api/user', { headers: { authorization: `Basic ${Buffer.from('admin:admin').toString('base64')}` } })).status).toBe(401);
    const settings = await viaProxy('grafana.test', '/api/frontend/settings', { headers: { authorization: `Basic ${Buffer.from(`admin:${gpass}`).toString('base64')}` } });
    expect(settings.body).toContain('https://grafana.test/');

    const kuma = await untilProxy('kuma.test', '/', (r) => r.status === 200 || r.status === 302);
    expect([200, 302], kuma.body.slice(0, 200)).toContain(kuma.status);
    const page = await untilProxy('kuma.test', '/setup', (r) => r.status === 200);
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/Uptime Kuma/i);
    report.adminer = { ui: adminer.status, mysqlLogin: true };
    report.grafana = { health: grafana.status, adminLogin: user.status, rootUrl: true };
    report.uptimeKuma = { ui: kuma.status, setup: page.status };
  }, 600_000);
  // ── SeaweedFS, and rollbacks across version lines ─────────────────────────

  it('SeaweedFS: buckets and objects with SigV4 from an app, wrong keys refused, data kept across a recreate', async () => {
    const made = await create({ name: 'blobs', template: 'seaweedfs', domain: 's3.test', tls: 'internal' });
    report.seaweedfsCreateMs = made.ms;
    expect(logOf(made.events)).toContain('Generated AWS_SECRET_ACCESS_KEY on the server');
    const releases = (await api('GET', deployApi('/apps/blobs/releases'))).json() as Array<{ digest: string; ref: string; service: string; line: string }>;
    expect(releases[0]).toMatchObject({ ref: imageOf('seaweedfs'), service: 'seaweedfs', line: '4' });
    expect(imageOf('seaweedfs').endsWith(releases[0]!.digest)).toBe(true);

    const conn = await connection('blobs', 'S3 endpoint');
    expect(conn.url).toBe('http://blobs:8333');
    const access = conn.values.AWS_ACCESS_KEY_ID!;
    const secret = conn.values.AWS_SECRET_ACCESS_KEY!;
    expect(access).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{40}$/);
    const curl = (args: string) => client('curlimages/curl:8.16.0', `-sS ${args}`);
    const s3 = (args: string) => curl(`-f --aws-sigv4 aws:amz:us-east-1:s3 --user ${q(`${access}:${secret}`)} ${args}`);
    s3('-X PUT http://blobs:8333/uploads');
    s3('-X PUT --data-binary hello -H "Content-Type: text/plain" http://blobs:8333/uploads/hello.txt');
    expect(s3('http://blobs:8333/uploads/hello.txt')).toBe('hello');
    expect(s3('http://blobs:8333/uploads?list-type=2')).toContain('<Key>hello.txt</Key>');
    // Creating it again: the SDKs' BucketAlreadyOwnedByYou (the docs tell apps to ignore it)
    const again = curl(`-o /dev/null -w '%{http_code}' --aws-sigv4 aws:amz:us-east-1:s3 --user ${q(`${access}:${secret}`)} -X PUT http://blobs:8333/uploads`);
    const againBody = curl(`--aws-sigv4 aws:amz:us-east-1:s3 --user ${q(`${access}:${secret}`)} -X PUT http://blobs:8333/uploads`);
    // Refused: a wrong secret, an unknown key, no signature at all
    const status = (args: string) => curl(`-o /dev/null -w '%{http_code}' ${args}`);
    expect(status(`--aws-sigv4 aws:amz:us-east-1:s3 --user ${q(`${access}:wrong-secret`)} http://blobs:8333/uploads/hello.txt`)).toBe('403');
    expect(status(`--aws-sigv4 aws:amz:us-east-1:s3 --user ${q(`nobody:${secret}`)} http://blobs:8333/uploads/hello.txt`)).toBe('403');
    expect(status('http://blobs:8333/uploads/hello.txt')).toBe('403');
    expect(status('http://blobs:8333/')).toBe('403');
    // Master, volume server and filer listen on the container's loopback only
    const closed = ['9333', '8080', '8888', '19333', '18888'].map((p) => client(`--entrypoint sh ${imageOf('memcached')}`, `-c ${q(`nc -z -w 3 blobs ${p} && echo open || echo closed`)}`));
    expect(closed).toEqual(['closed', 'closed', 'closed', 'closed', 'closed']);
    // No key on a command line: not in the container's Cmd or Entrypoint, not in its process list
    const id = sh(`docker ps -q --filter label=bastion.app=blobs`).trim();
    const argv = sh(`docker inspect -f '{{json .Config.Cmd}} {{json .Config.Entrypoint}}' ${id}`) + sh(`docker exec ${id} ps -o args`);
    const signing = await api('POST', deployApi('/apps/blobs/env/WEED_JWT_FILER_SIGNING_KEY/reveal'), undefined, browser.headers);
    expect(signing.statusCode, signing.body).toBe(200);
    for (const value of [secret, access, (signing.json() as { value: string }).value]) expect(argv).not.toContain(value);
    expect(sh(`docker exec ${id} ps -o user,args`)).toMatch(/seaweed\s+\/usr\/bin\/weed .*server/);

    // Through Caddy on its domain (tls internal), signed for that host
    const viaDomain = (args: string[]) =>
      execFileSync('curl', ['-sS', '-k', '--resolve', `s3.test:${HTTPS_PORT}:127.0.0.1`, '--aws-sigv4', 'aws:amz:us-east-1:s3', '--user', `${access}:${secret}`, ...args], { encoding: 'utf8' });
    let viaProxyBody = '';
    for (let i = 0; i < 45 && viaProxyBody !== 'hello'; i++) {
      try {
        viaProxyBody = viaDomain(['-f', `https://s3.test:${HTTPS_PORT}/uploads/hello.txt`]);
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    expect(viaProxyBody).toBe('hello');
    viaDomain(['-f', '-X', 'PUT', '--data-binary', 'from outside', `https://s3.test:${HTTPS_PORT}/uploads/outside.txt`]);
    expect((await viaProxy('s3.test', '/uploads/hello.txt')).status).toBe(403);

    // A recreate redeploy: the old container stops, a new one starts on the same /data; the objects are there
    const redeploy = await stream(deployApi('/apps/blobs/deploy'), {});
    expect(outcomeOf(redeploy)?.result, logOf(redeploy)).toBe('success');
    expect(logOf(redeploy)).toContain('before the new container starts (volume data is exclusive)');
    expect(s3('http://blobs:8333/uploads/hello.txt')).toBe('hello');
    expect(s3('http://blobs:8333/uploads/outside.txt')).toBe('from outside');
    expect(sh(`docker ps -a --filter label=bastion.app=blobs --format '{{.Names}}'`).trim().split('\n')).toHaveLength(1);
    const backups = (await api('GET', deployApi('/apps/blobs/backups'))).json() as { supported: boolean };
    expect(backups.supported).toBe(false);
    report.seaweedfs = { image: imageOf('seaweedfs'), bucket: true, putGet: true, bucketAgain: { status: again, body: againBody.slice(0, 160) }, refused: [403, 403, 403], loopbackOnly: true, viaCaddy: true, keptAcrossRecreate: true };
  }, 900_000);

  it('Grafana: a rollback to an older version line is refused, within the line allowed', async () => {
    await create({ name: 'dash12', template: 'grafana', version: '12' });
    const grafana = serviceTemplate('grafana')!;
    const updated = await stream(deployApi('/apps/dash12/service/version'), { version: '13' });
    expect(outcomeOf(updated)?.result, logOf(updated)).toBe('success');
    // A second 13 release: the same image deployed again
    const again = await stream(deployApi('/apps/dash12/deploy'), {});
    expect(outcomeOf(again)?.result, logOf(again)).toBe('success');

    type Rel = { id: string; line: string; current: boolean; rollbackRefused?: string | null; ref: string };
    const releases = (await api('GET', deployApi('/apps/dash12/releases'))).json() as Rel[];
    const on12 = releases.find((r) => r.line === '12')!;
    const on13 = releases.filter((r) => r.line === '13');
    expect(on12.ref).toBe(serviceVersion(grafana, '12')!.image);
    expect(on13).toHaveLength(2);
    expect(on13[0]!.current).toBe(true);
    expect(on12.rollbackRefused).toContain('Grafana cannot be moved back from Grafana 13 to Grafana 12');
    expect(on13[1]!.rollbackRefused).toBeNull();

    const refused = await api('POST', deployApi('/apps/dash12/rollback'), { release: on12.id });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'line_change_refused', docs: '/docs/deployments/releases-rollback#version-lines' });
    expect(audits('deploy.rollback').at(-1)).toMatchObject({ app: 'dash12', release: on12.id, result: 'refused' });
    // bastionctl refuses it on its own too (a shell on the server)
    let cli = '';
    try {
      sh(`${ROOT}/bin/bastionctl rollback dash12 ${on12.id} --json`);
    } catch (err) {
      cli = String((err as { stdout?: string }).stdout ?? '');
    }
    expect(JSON.parse(cli.trim().split('\n').at(-1)!)).toMatchObject({ refused: 'line_change', error: expect.stringContaining('moved back from Grafana 13 to Grafana 12') });

    const within = await stream(deployApi('/apps/dash12/rollback'), { release: on13[1]!.id });
    expect(outcomeOf(within)?.result, logOf(within)).toBe('success');
    const after = (await api('GET', deployApi('/apps/dash12/releases'))).json() as Rel[];
    expect(after.find((r) => r.current)!.id).toBe(on13[1]!.id);
    expect(sh(`docker ps --filter label=bastion.app=dash12 --format '{{.Image}}'`).trim()).toBe(`bastion-dash12:${on13[1]!.id}`);
    report.grafanaRollback = { release12: on12.id, refused: refused.statusCode, code: refused.json().code, cliRefused: true, withinLine: 'success' };
  }, 900_000);
});
