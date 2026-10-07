import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Deployments against a real server: a throwaway `docker:dind` daemon and an
 * `openssh-server` with the Docker CLI, sharing the daemon's socket and the
 * deployments folder (so paths bastionctl hands the daemon exist there too).
 * Never the host's own Docker. Everything goes through the real routes, the
 * SSH and SFTP pools, the shipped bastionctl bundle and its wrapper.
 *
 *   docker network create bastion-it-net
 *   docker volume create bastion-it-sock && docker volume create bastion-it-root
 *   docker run -d --rm --privileged --name bastion-it-dind2 --network bastion-it-net -e DOCKER_TLS_CERTDIR= \
 *     -v bastion-it-sock:/var/run -v bastion-it-root:/config/bastion docker:dind
 *   docker run -d --rm --name bastion-it-sshd --network bastion-it-net -p 127.0.0.1:22522:2222 \
 *     -e USER_NAME=smt -e USER_PASSWORD=bastion-it-pass -e PASSWORD_ACCESS=true -e PUID=1000 -e PGID=1000 \
 *     -v bastion-it-sock:/sock -v bastion-it-root:/config/bastion lscr.io/linuxserver/openssh-server
 *   docker exec bastion-it-dind2 sh -c 'until [ -S /var/run/docker.sock ]; do sleep 1; done; chmod 666 /var/run/docker.sock; chown 1000:1000 /config/bastion'
 *   docker exec bastion-it-sshd sh -c 'apk add --no-cache docker-cli && ln -sf /sock/docker.sock /var/run/docker.sock'
 *
 *   SMT_TEST_DEPLOY_SSH_HOST=127.0.0.1 SMT_TEST_DEPLOY_SSH_PORT=22522 pnpm vitest run src/deploy/deploy.integration.test.ts
 *
 *   docker stop bastion-it-sshd bastion-it-dind2 && docker volume rm bastion-it-sock bastion-it-root && docker network rm bastion-it-net
 *
 * The SSH user (smt, home /config) cannot create /opt/bastion, so the root is
 * $HOME/bastion. The daemon pulls node, caddy and busybox (registry access).
 */

const host = process.env.SMT_TEST_DEPLOY_SSH_HOST;
const port = Number(process.env.SMT_TEST_DEPLOY_SSH_PORT ?? 22);
const username = process.env.SMT_TEST_DEPLOY_SSH_USER ?? 'smt';
const password = process.env.SMT_TEST_DEPLOY_SSH_PASSWORD ?? 'bastion-it-pass';

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');
const { bastionctlBundle } = await import('./bundle.js');
const { getDb } = await import('../db/index.js');
const { auditLog } = await import('../db/schema.js');
const { createHash } = await import('node:crypto');
const { eq } = await import('drizzle-orm');

/** A .tar.gz of a one-file Dockerfile app answering `body` on port 3000. */
function source(body: string): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-it-src-'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), `FROM busybox:1.36\nRUN mkdir /www && echo ${body} > /www/index.html\nCMD ["httpd", "-f", "-p", "3000", "-h", "/www"]\n`);
  const file = path.join(dir, 'src.tar.gz');
  execFileSync('tar', ['czf', file, '-C', dir, 'Dockerfile'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const data = fs.readFileSync(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return data;
}

describe.skipIf(!host)('deployments against a live server over SSH', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let admin: ReturnType<typeof seedUser>;
  let serverId: string;

  const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: admin.headers, ...(payload && { payload }) });
  const deployApi = (p = '') => `/api/deploy/servers/${serverId}${p}`;

  async function stream(url: string, init: RequestInit): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`${base}${url}`, { ...init, headers: { ...admin.headers, ...(init.headers as Record<string, string>) } });
    expect(res.headers.get('content-type'), await res.clone().text().catch(() => '')).toBe('text/event-stream');
    const text = await res.text();
    return text
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
  }

  const deploy = (body: string) => {
    const form = new FormData();
    form.append('source', new Blob([source(body)]), 'src.tar.gz');
    return stream(deployApi('/apps/site1/deploy'), { method: 'POST', body: form });
  };

  beforeAll(async () => {
    await runMigrations();
    const orgId = seedOrg('deploy-it');
    admin = seedUser(orgId, 'admin');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const res = await api('POST', '/api/servers', { name: 'deploy-it', host, port, username, authType: 'password', password });
    expect(res.statusCode, res.body).toBe(201);
    serverId = res.json().id;
  }, 60_000);

  afterAll(async () => {
    if (serverId) await api('DELETE', deployApi('/apps/site1?purge=true')).catch(() => {});
    await app?.close();
  });

  it('sets the server up in $HOME/bastion with the shipped bastionctl', async () => {
    expect((await api('GET', deployApi())).json()).toMatchObject({ root: null, integrity: 'missing' });
    const res = await api('POST', deployApi('/setup'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ root: '/config/bastion', proxy: 'caddy', network: 'bastion-apps', proxyContainer: { state: 'running' } });
    expect((await api('GET', deployApi())).json()).toMatchObject({ root: '/config/bastion', integrity: 'ok' });
  }, 300_000);

  it('writes a validated config, refusing an invalid one', async () => {
    const bad = await api('PUT', deployApi('/apps/site1/config'), { text: 'name: site1\ndomains: [site1.test]\nbuild: { type: dockerfile }\nrun: { port: 0 }\n' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors).toEqual([{ path: 'run.port', message: 'A port from 1 to 65535' }]);
    const text = 'name: site1\ndomains: [site1.test]\ntls: internal\nbuild: { type: dockerfile }\nrun: { port: 3000 }\nhealthcheck: { path: /, timeout: 30s }\n';
    const ok = await api('PUT', deployApi('/apps/site1/config'), { text });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await api('GET', deployApi('/apps/site1/config'))).json()).toEqual({ text });
  }, 120_000);

  it('deploys an upload with a live log, then a second release, then rolls back', async () => {
    const first = await deploy('v1');
    const result = first.find((e) => e.type === 'result') as { outcome: { release: string; result: string } } | undefined;
    expect(result?.outcome.result, JSON.stringify(first)).toBe('success');
    expect(first.some((e) => e.type === 'log' && JSON.stringify(e).includes('Health check passed'))).toBe(true);

    const second = (await deploy('v2')).find((e) => e.type === 'result') as { outcome: { release: string; result: string; previous: string } };
    expect(second.outcome).toMatchObject({ result: 'success', previous: result!.outcome.release });

    const apps = (await api('GET', deployApi('/apps'))).json();
    expect(apps).toEqual([expect.objectContaining({ name: 'site1', currentRelease: second.outcome.release, container: expect.objectContaining({ state: 'running' }) })]);

    const back = await stream(deployApi('/apps/site1/rollback'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ release: result!.outcome.release }),
    });
    expect(back.find((e) => e.type === 'result')).toMatchObject({ outcome: { result: 'success', release: result!.outcome.release } });
    const releases = (await api('GET', deployApi('/apps/site1/releases'))).json() as Array<{ id: string; current: boolean; actor: string }>;
    expect(releases.find((r) => r.current)?.id).toBe(result!.outcome.release);
    expect(releases[0]!.actor).toMatch(/@test\.local$/);
  }, 600_000);

  it('keeps .env values off command lines and lists only names', async () => {
    expect((await api('PUT', deployApi('/apps/site1/env/API_KEY'), { value: "it's a secret" })).statusCode).toBe(200);
    expect((await api('GET', deployApi('/apps/site1/env'))).json()).toEqual({ keys: ['API_KEY'] });
  }, 120_000);

  const BIN = '/config/bastion/bin';
  const putFile = (file: string, data: Buffer) =>
    app.inject({
      method: 'PUT',
      url: `/api/sftp/${serverId}/file?path=${encodeURIComponent(file)}`,
      headers: { ...admin.headers, 'content-type': 'application/octet-stream' },
      payload: data,
    });
  const upgrades = () =>
    getDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'deploy.bastionctl_upgrade'))
      .all()
      .map((r) => JSON.parse(r.metadata ?? '{}') as Record<string, unknown>);
  async function installedSha(): Promise<string> {
    const res = await app.inject({ method: 'GET', url: `/api/sftp/${serverId}/download?path=${encodeURIComponent(`${BIN}/bastionctl.mjs`)}`, headers: admin.headers });
    expect(res.statusCode).toBe(200);
    return createHash('sha256').update(res.rawPayload).digest('hex');
  }

  it('upgrades an older bastionctl on the next request and runs it; leaves a pinned one alone until unpinned', async () => {
    const bundle = bastionctlBundle()!;
    expect(bundle.version).toMatch(/^0\.1\.0\+[0-9a-f]{7}$/);
    // An older bastionctl: this one as built before build ids (it says plain 0.1.0), a working program all the same
    const older = Buffer.from(bundle.script.toString('utf8').replace(/^\/\/ bastionctl .*\n/m, '').replaceAll(`"${bundle.version}"`, '"0.1.0"'));
    expect(older.equals(bundle.script)).toBe(false);

    // Pinned: refused, and the state says why
    expect((await putFile(`${BIN}/.pinned`, Buffer.from('testing an update on another server first\n'))).statusCode).toBe(201);
    expect((await putFile(`${BIN}/bastionctl.mjs`, older)).statusCode).toBe(201);
    expect((await api('GET', deployApi())).json()).toMatchObject({ integrity: 'mismatch', pinned: true, installedVersion: '0.1.0', version: bundle.version });
    const refused = await api('GET', deployApi('/apps'));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'bastionctl_mismatch', pinned: true });
    expect(upgrades()).toEqual([]);

    // Unpinned: the next request upgrades it, checks it, and runs the command
    const unpin = await app.inject({ method: 'DELETE', url: `/api/sftp/${serverId}/file?path=${encodeURIComponent(`${BIN}/.pinned`)}`, headers: admin.headers });
    expect(unpin.statusCode, unpin.body).toBeLessThan(300);
    const apps = await api('GET', deployApi('/apps'));
    expect(apps.statusCode, apps.body).toBe(200);
    expect(apps.json()).toEqual([expect.objectContaining({ name: 'site1' })]);
    expect(await installedSha()).toBe(bundle.scriptSha256);
    expect(upgrades()).toEqual([{ root: '/config/bastion', from: '0.1.0', to: bundle.version, result: 'success', trigger: 'request' }]);
    expect((await api('GET', deployApi())).json()).toMatchObject({ root: '/config/bastion', integrity: 'ok', version: bundle.version, installedVersion: bundle.version, pinned: false, proxyOutdated: false });

    // Requests arriving together after another replacement: one upgrade, every command runs
    expect((await putFile(`${BIN}/bastionctl.mjs`, older)).statusCode).toBe(201);
    const together = await Promise.all([api('GET', deployApi('/apps')), api('GET', deployApi('/apps/site1')), api('GET', deployApi('/apps/site1/releases'))]);
    expect(together.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(upgrades()).toHaveLength(2);
    expect(await installedSha()).toBe(bundle.scriptSha256);

    // A modified program is replaced the same way, and deploying works on the upgraded one
    expect((await putFile(`${BIN}/bastionctl.mjs`, Buffer.from('console.log("not ours")\n'))).statusCode).toBe(201);
    const third = (await deploy('v3')).find((e) => e.type === 'result') as { outcome: { result: string } } | undefined;
    expect(third?.outcome.result).toBe('success');
    expect(upgrades().map((u) => u.from)).toEqual(expect.arrayContaining([null]));
    expect(await installedSha()).toBe(bundle.scriptSha256);
  }, 600_000);

  it('deletes the app', async () => {
    const res = await api('DELETE', deployApi('/apps/site1?purge=true'));
    expect(res.statusCode, res.body).toBe(200);
    expect((await api('GET', deployApi('/apps'))).json()).toEqual([]);
  }, 120_000);
});
