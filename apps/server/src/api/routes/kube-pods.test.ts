import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { and, eq } from 'drizzle-orm';
import type { KubeCluster, KubeExecSession, KubeObjectYaml, KubePodDetail, SessionRecording } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, organizations, sessionRecordings } from '../../db/schema.js';
import { config } from '../../config/index.js';
import { revokeLiveAccess } from '../../auth/revoke.js';
import { resetKubeCache } from '../../kube/cache.js';
import { activeKubeStreamCount } from '../../kube/sse.js';
import { fakeKubeconfig, pod, startFakeApi, type FakeApi } from '../../kube/fake-api.test-helper.js';
import { fakePods, type FakePods } from '../../kube/fake-pod-api.test-helper.js';
import { seedOrg, seedUser } from './test-utils.js';

/**
 * Inside a pod (K4) end to end against the fake API server: the pod panel,
 * logs (role gate, SSE, previous, download, revocation), the shell (role and
 * org toggle, the terminal WebSocket, resize, recording, audit, and every way
 * it is closed from outside: revocation, losing the cluster, demotion, the
 * org switch, the cluster being removed), and the redacted YAML view.
 */

type Who = { userId: string; headers: Record<string, string> };

const until = async (check: () => boolean, ms = 4000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('kube pod routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let api: FakeApi;
  let pods: FakePods;
  let base: string;
  let wsBase: string;
  let orgId: string;
  let admin: Who;
  let operator: Who;
  let viewer: Who;
  let restricted: Who;
  let outsider: Who;
  let clusterId: string;
  const sockets: WebSocket[] = [];
  const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-kube-exec-rec-'));
  const originalRecordingsDir = config.recordings.dir;

  const get = (who: Who, url: string) => app.inject({ method: 'GET', url, headers: who.headers });
  const send = (who: Who, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: who.headers, ...(payload && { payload }) });
  const c = (rest = '') => `/api/kube/clusters/${clusterId}${rest}`;
  const openShell = (who: Who, body: object = {}, podName = 'web-1') =>
    send(who, 'POST', c(`/pods/shop/${podName}/exec`), { cols: 100, rows: 30, ...body });

  const audits = (action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.orgId, orgId)))
      .all()
      .map((r) => JSON.parse(r.metadata ?? '{}') as Record<string, unknown>);

  async function openStream(who: Who, url: string) {
    const abort = new AbortController();
    const res = await fetch(`${base}${url}`, { headers: who.headers, signal: abort.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const next = async (): Promise<Record<string, unknown> | null> => {
      for (;;) {
        const at = buffer.indexOf('\n\n');
        if (at !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (block.startsWith('data: ')) return JSON.parse(block.slice(6)) as Record<string, unknown>;
          continue;
        }
        const { done, value } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    };
    return { res, next, close: () => abort.abort() };
  }

  async function attach(who: Who, session: KubeExecSession) {
    const ws = new WebSocket(`${wsBase}/api/ssh-sessions/${session.sessionId}/ws`, { headers: who.headers });
    sockets.push(ws);
    const term = { ws, text: '', closeCode: null as number | null };
    ws.on('message', (data: Buffer) => (term.text += data.toString()));
    ws.on('close', (code) => (term.closeCode = code));
    await once(ws, 'open');
    return term;
  }

  async function shellFor(who: Who) {
    const res = await openShell(who);
    expect(res.statusCode).toBe(201);
    const session = res.json() as KubeExecSession;
    const term = await attach(who, session);
    await until(() => term.text.includes('$ '));
    return { session, term, exec: pods.execs.at(-1)! };
  }

  beforeAll(async () => {
    (config.recordings as { dir: string }).dir = recordingsDir;
    await runMigrations();
    api = await startFakeApi();
    pods = fakePods(api);
    api.add('namespaces', { kind: 'Namespace', metadata: { name: 'shop' }, status: { phase: 'Active' } });
    api.add('namespaces', { kind: 'Namespace', metadata: { name: 'other' }, status: { phase: 'Active' } });
    api.add('pods', pod('shop', 'web-1', { secretEnv: { secret: 'db', key: 'password' } }));
    api.add('pods', pod('shop', 'crashy', { waiting: 'CrashLoopBackOff', restarts: 4 }));
    api.add('pods', pod('other', 'side', {}));
    api.add('secrets', { kind: 'Secret', type: 'Opaque', metadata: { name: 'db', namespace: 'shop' }, data: { password: 'aHVudGVyMg==' } });
    pods.setLogs('shop', 'web-1', 'app', ['booting', 'listening on :8080'], ['panic: boom']);
    pods.setLogs('other', 'side', 'app', ['elsewhere']);

    orgId = seedOrg('org-kube-pods');
    getDb().update(organizations).set({ recordingEnabled: true }).where(eq(organizations.id, orgId)).run();
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    restricted = seedUser(orgId, 'operator');
    outsider = seedUser(seedOrg('org-kube-pods-other'), 'admin');

    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;

    const created = await send(admin, 'POST', '/api/kube/clusters', { name: 'prod', kubeconfig: fakeKubeconfig(api) });
    expect(created.statusCode).toBe(201);
    clusterId = (created.json() as KubeCluster).id;
    expect(
      (await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, { serverAccess: 'restricted', serverIds: [], clusterIds: [] })).statusCode,
    ).toBe(200);
  });

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    resetKubeCache();
    await app.close();
    pods.close();
    await api.close();
    (config.recordings as { dir: string }).dir = originalRecordingsDir;
    fs.rmSync(recordingsDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await send(admin, 'PATCH', '/api/kube/settings', { operatorsCanExec: true });
  });

  describe('pod panel', () => {
    it('shows containers as lanes to anyone who may view the cluster', async () => {
      const res = await get(viewer, c('/pods/shop/crashy'));
      expect(res.statusCode).toBe(200);
      const d = res.json() as KubePodDetail;
      expect(d).toMatchObject({ name: 'crashy', namespace: 'shop', defaultContainer: 'app', metricsAvailable: false });
      expect(d.containers[0]).toMatchObject({ name: 'app', role: 'app', state: 'waiting', reason: 'CrashLoopBackOff', restarts: 4 });
      expect(d.containers[0]!.requests).toEqual({ cpuMillis: 100, memoryBytes: 128 * 2 ** 20 });
    });

    it('is a 404 for restricted members, other orgs, and bad names', async () => {
      expect((await get(restricted, c('/pods/shop/web-1'))).statusCode).toBe(404);
      expect((await get(outsider, c('/pods/shop/web-1'))).statusCode).toBe(404);
      expect((await get(admin, c('/pods/shop/nope'))).statusCode).toBe(404);
      expect((await get(admin, c('/pods/Bad_NS/web-1'))).statusCode).toBe(400);
    });
  });

  describe('logs', () => {
    it('are for operators and up', async () => {
      expect((await get(viewer, c('/pods/shop/web-1/logs'))).statusCode).toBe(403);
      expect((await get(viewer, c('/pods/shop/web-1/logs/download'))).statusCode).toBe(403);
      expect((await get(restricted, c('/pods/shop/web-1/logs'))).statusCode).toBe(404);
    });

    it('stream the default container’s tail, then end', async () => {
      const stream = await openStream(operator, c('/pods/shop/web-1/logs?tail=10'));
      expect(stream.res.headers.get('content-type')).toMatch(/text\/event-stream/);
      expect(await stream.next()).toEqual({ type: 'ready', container: 'app', previous: false });
      expect(await stream.next()).toEqual({ type: 'logs', lines: [{ text: 'booting' }, { text: 'listening on :8080' }] });
      expect(await stream.next()).toEqual({ type: 'end' });
    });

    it('read the previous run, and answer plainly when there is none or the container is unknown', async () => {
      const stream = await openStream(operator, c('/pods/shop/web-1/logs?previous=1'));
      expect(await stream.next()).toEqual({ type: 'ready', container: 'app', previous: true });
      expect(await stream.next()).toEqual({ type: 'logs', lines: [{ text: 'panic: boom' }] });
      const none = await get(operator, c('/pods/shop/crashy/logs?previous=1'));
      expect(none.statusCode).toBe(400);
      const unknown = await get(operator, c('/pods/shop/web-1/logs?container=sidecar'));
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error).toMatch(/no container named sidecar/);
    });

    it('download as plain text', async () => {
      const res = await get(admin, c('/pods/shop/web-1/logs/download?previous=1'));
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="web-1-app-previous.log"');
      expect(res.body).toBe('panic: boom\n');
    });

    it('follow until access is revoked, which ends the stream', async () => {
      const stream = await openStream(operator, c('/pods/shop/web-1/logs?follow=1&tail=0'));
      expect((await stream.next())?.type).toBe('ready');
      await until(() => pods.followers() === 1);
      pods.log('shop', 'web-1', 'app', 'request 1');
      expect(await stream.next()).toEqual({ type: 'logs', lines: [{ text: 'request 1' }] });
      expect(activeKubeStreamCount(operator.userId)).toBe(1);
      revokeLiveAccess(operator.userId, { orgId });
      expect(await stream.next()).toMatchObject({ type: 'error', status: 403 });
      await until(() => pods.followers() === 0 && activeKubeStreamCount(operator.userId) === 0);
    });

    it('respect the cluster’s namespace allowlist', async () => {
      expect((await send(admin, 'PATCH', c(), { namespacesAllowlist: ['shop'], defaultNamespace: 'shop' })).statusCode).toBe(200);
      expect((await get(admin, c('/pods/other/side/logs'))).statusCode).toBe(404);
      expect((await get(admin, c('/pods/other/side'))).statusCode).toBe(404);
      expect((await send(admin, 'POST', c('/pods/other/side/exec'), {})).statusCode).toBe(404);
      expect((await send(admin, 'PATCH', c(), { namespacesAllowlist: null })).statusCode).toBe(200);
    });
  });

  describe('shell', () => {
    it('opens a recorded, audited terminal session that resizes and takes input', async () => {
      const { session, term, exec } = await shellFor(operator);
      expect(session.pod).toEqual({ clusterId, clusterName: 'prod', namespace: 'shop', name: 'web-1', container: 'app' });
      expect(session.cmd[0]).toBe('/bin/sh');
      expect(exec.query.get('container')).toBe('app');
      expect(exec.resizes[0]).toEqual({ Width: 100, Height: 30 });
      term.ws.send(JSON.stringify({ type: 'resize', cols: 140, rows: 45 }));
      await until(() => exec.resizes.length === 2);
      expect(exec.resizes[1]).toEqual({ Width: 140, Height: 45 });
      term.ws.send('whoami\r');
      await until(() => term.text.includes('whoami'));

      const row = getDb().select().from(sessionRecordings).where(eq(sessionRecordings.id, session.recording!.id)).get()!;
      expect(row).toMatchObject({ kind: 'pod', serverId: null, serverName: 'prod', command: 'shop/web-1/app' });
      const listed = (await get(admin, '/api/recordings?kind=pod')).json() as { items?: SessionRecording[]; data?: SessionRecording[] };
      const items = listed.items ?? listed.data ?? [];
      expect(items.find((r) => r.id === row.id)?.pod).toEqual({ namespace: 'shop', name: 'web-1', container: 'app' });
      expect(audits('kube.exec_start').at(-1)).toMatchObject({ namespace: 'shop', pod: 'web-1', container: 'app', sessionId: session.sessionId });

      // The process exits: the session ends, audited with the exit code
      term.ws.send('exit 7\r');
      await until(() => term.closeCode !== null);
      await until(() => audits('kube.exec_end').some((a) => a.sessionId === session.sessionId));
      expect(audits('kube.exec_end').find((a) => a.sessionId === session.sessionId)).toMatchObject({ exitCode: 7 });
    });

    it('is refused to viewers, to operators when the org turns it off, and on a container that is not running', async () => {
      expect((await openShell(viewer)).statusCode).toBe(403);
      expect((await openShell(restricted)).statusCode).toBe(404);
      await send(admin, 'PATCH', '/api/kube/settings', { operatorsCanExec: false });
      expect((await openShell(operator)).statusCode).toBe(403);
      expect((await openShell(admin)).statusCode).toBe(201);
      const crashy = await openShell(admin, {}, 'crashy');
      expect(crashy.statusCode).toBe(409);
      expect(crashy.json().error).toMatch(/not running \(CrashLoopBackOff\)/);
    });

    it('closes when access is revoked', async () => {
      const { term, exec } = await shellFor(operator);
      revokeLiveAccess(operator.userId, { orgId });
      await until(() => term.closeCode === 4403);
      await until(() => exec.closed);
    });

    it('keeps a shell on a cluster still granted when only servers change, and closes it when the cluster grant goes', async () => {
      await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, { serverAccess: 'restricted', serverIds: [], clusterIds: [clusterId] });
      const { term } = await shellFor(restricted);
      revokeLiveAccess(restricted.userId, { orgId, keepServerIds: [], keepClusterIds: [clusterId] });
      await new Promise((r) => setTimeout(r, 100));
      expect(term.closeCode).toBeNull();
      await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, { serverAccess: 'restricted', serverIds: [], clusterIds: [] });
      await until(() => term.closeCode === 4403);
    });

    it('closes operators’ shells when the org switches exec off, and a demoted member’s', async () => {
      const first = await shellFor(operator);
      const adminShell = await shellFor(admin);
      await send(admin, 'PATCH', '/api/kube/settings', { operatorsCanExec: false });
      await until(() => first.term.closeCode === 4403);
      expect(adminShell.term.closeCode).toBeNull();
      await send(admin, 'PATCH', '/api/kube/settings', { operatorsCanExec: true });

      const demoted = seedUser(orgId, 'operator');
      const second = await shellFor(demoted);
      expect((await send(admin, 'PATCH', `/api/team/members/${demoted.userId}`, { role: 'viewer' })).statusCode).toBe(200);
      await until(() => second.term.closeCode === 4403);
    });

    it('cannot be re-attached once the exec capability is gone', async () => {
      const res = await openShell(operator);
      const session = res.json() as KubeExecSession;
      await send(admin, 'PATCH', '/api/kube/settings', { operatorsCanExec: false });
      const ws = new WebSocket(`${wsBase}/api/ssh-sessions/${session.sessionId}/ws`, { headers: operator.headers });
      sockets.push(ws);
      const [code] = (await once(ws, 'close')) as [number];
      expect([4403, 4404]).toContain(code);
    });
  });

  describe('YAML', () => {
    it('is for operators and up, with Secret values removed and the view audited', async () => {
      expect((await get(viewer, c('/objects/secrets/shop/db/yaml'))).statusCode).toBe(403);
      const res = await get(operator, c('/objects/secrets/shop/db/yaml'));
      expect(res.statusCode).toBe(200);
      const body = res.json() as KubeObjectYaml;
      expect(body.redacted).toBe(true);
      expect(body.yaml).toContain('password: ••••');
      expect(body.yaml).not.toContain('aHVudGVyMg==');
      expect(audits('kube.secret_view').at(-1)).toMatchObject({ namespace: 'shop', name: 'db', view: 'yaml' });
    });

    it('shows env values from Secrets as the reference only', async () => {
      const body = (await get(operator, c('/objects/pods/shop/web-1/yaml'))).json() as KubeObjectYaml;
      expect(body.redacted).toBe(false);
      expect(body.yaml).toMatch(/secretKeyRef:\s+name: db\s+key: password/);
      expect(body.yaml).not.toContain('hunter2');
      expect((await get(restricted, c('/objects/pods/shop/web-1/yaml'))).statusCode).toBe(404);
    });
  });

  describe('cluster removal', () => {
    it('closes the shells on it', async () => {
      const { term } = await shellFor(admin);
      expect((await send(admin, 'DELETE', c())).statusCode).toBeLessThan(300);
      await until(() => term.closeCode !== null);
    });
  });
});
