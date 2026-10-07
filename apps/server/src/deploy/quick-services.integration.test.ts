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
  });

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
});
