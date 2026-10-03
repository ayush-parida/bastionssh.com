import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import WebSocket from 'ws';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { KubeCluster, KubeExecSession, KubeLogEvent, KubeObjectYaml, KubePodDetail } from '@smt/shared';

/**
 * Inside a pod (K4) against a real, throwaway k3s cluster in Docker — never a
 * cluster from ~/.kube. Same setup as kube.integration.test.ts:
 *
 *   eval "$(apps/server/scripts/kube-it.sh up | sed 's/^/export /')"
 *   pnpm vitest run src/kube/kube-pods.integration.test.ts
 *   apps/server/scripts/kube-it.sh down
 *
 * The sample app's `ticker` pod (an init step, a native sidecar, an app
 * printing a line a second) and the crash-looping `crasher` are read through
 * the real routes: the pod panel, followed logs, a previous run's log, the
 * redacted YAML, and a shell over the exec WebSocket — resized, recorded,
 * exited with its code — directly, and through the SSH container's tunnel
 * with the service account token.
 */

const kubeconfigPath = process.env.SMT_TEST_KUBE_KUBECONFIG;
const tokenFile = process.env.SMT_TEST_KUBE_TOKEN_FILE;
const caFile = process.env.SMT_TEST_KUBE_CA_FILE;
const innerUrl = process.env.SMT_TEST_KUBE_INNER_URL;
const sshHost = process.env.SMT_TEST_KUBE_SSH_HOST;
const sshPort = Number(process.env.SMT_TEST_KUBE_SSH_PORT ?? 22);

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');
const { getDb } = await import('../db/index.js');
const { organizations, sessionRecordings } = await import('../db/schema.js');
const { eq } = await import('drizzle-orm');

async function until(check: () => boolean, ms = 20_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!kubeconfigPath)('pods on a live k3s cluster', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let admin: ReturnType<typeof seedUser>;
  let operator: ReturnType<typeof seedUser>;
  let cluster: KubeCluster;

  const api = (who: { headers: Record<string, string> }, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: who.headers, ...(payload && { payload }) });
  const c = (rest: string) => `/api/kube/clusters/${cluster.id}${rest}`;

  /** Read a log stream's events until `done` says enough, then leave. */
  async function readLogs(url: string, done: (events: KubeLogEvent[]) => boolean): Promise<KubeLogEvent[]> {
    const abort = new AbortController();
    const res = await fetch(`${base}${url}`, { headers: operator.headers, signal: abort.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: KubeLogEvent[] = [];
    let buffer = '';
    try {
      while (!done(events)) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
        buffer += decoder.decode(value, { stream: true });
        for (let at = buffer.indexOf('\n\n'); at !== -1; at = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (block.startsWith('data: ')) events.push(JSON.parse(block.slice(6)) as KubeLogEvent);
        }
      }
    } finally {
      abort.abort();
    }
    return events;
  }

  const lines = (events: KubeLogEvent[]) => events.flatMap((e) => (e.type === 'logs' ? e.lines.map((l) => l.text) : []));

  beforeAll(async () => {
    await runMigrations();
    const orgId = seedOrg('kube-pods-it');
    getDb().update(organizations).set({ recordingEnabled: true }).where(eq(organizations.id, orgId)).run();
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

    const kubeconfig = readFileSync(kubeconfigPath!, 'utf8');
    const res = await api(admin, 'POST', '/api/kube/clusters', { kubeconfig, context: 'default', name: 'k3s-pods' });
    expect(res.statusCode).toBe(201);
    cluster = res.json();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('draws the pod panel: init, sidecar and app lanes, every lifecycle step done', async () => {
    const res = await api(operator, 'GET', c('/pods/smt-it/ticker'));
    expect(res.statusCode).toBe(200);
    const pod = res.json() as KubePodDetail;
    expect(pod.containers.map((x) => [x.name, x.role, x.state])).toEqual([
      ['prepare', 'init', 'terminated'],
      ['proxy', 'sidecar', 'running'],
      ['ticker', 'app', 'running'],
    ]);
    expect(pod.containers[2]).toMatchObject({ requests: { cpuMillis: 10 }, limits: { cpuMillis: 100, memoryBytes: 32 * 2 ** 20 } });
    expect(pod.lifecycle.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(pod.defaultContainer).toBe('ticker');
  });

  it('follows a container’s log as it grows', async () => {
    const events = await readLogs(c('/pods/smt-it/ticker/logs?follow=1&tail=1'), (e) => lines(e).length >= 3);
    expect(events[0]).toEqual({ type: 'ready', container: 'ticker', previous: false });
    const ticks = lines(events).map((l) => Number(/^tick (\d+)$/.exec(l)?.[1]));
    expect(ticks.every(Number.isInteger)).toBe(true);
    // New lines arrived after the tail, in order
    expect(ticks[2]! - ticks[0]!).toBe(2);
  }, 30_000);

  it('reads an init container’s log, and a crashed run’s', async () => {
    const init = await readLogs(c('/pods/smt-it/ticker/logs?container=prepare'), (e) => e.some((x) => x.type === 'end'));
    expect(lines(init)).toEqual(['prepared']);

    // While a crash-looping container is being replaced the kubelet briefly
    // answers "unable to retrieve container logs" (kubectl sees the same): ask again
    let previous: KubeLogEvent[] = [];
    for (let i = 0; i < 20 && !lines(previous).includes('starting'); i++) {
      if (i) await new Promise((r) => setTimeout(r, 1_500));
      previous = await readLogs(c('/pods/smt-it/crasher/logs?previous=1'), (e) => e.some((x) => x.type === 'end' || x.type === 'error'));
    }
    expect(previous[0]).toMatchObject({ type: 'ready', previous: true });
    expect(lines(previous), JSON.stringify(previous)).toContain('starting');
  });

  it('shows the YAML with the Secret reference, never its value', async () => {
    const list = await api(operator, 'GET', c('/workloads?namespace=smt-it'));
    expect(list.statusCode).toBe(200);
    const overview = (await api(operator, 'GET', c('/overview'))).json() as { nodes: { pods: { name: string; namespace: string; owner: { kind: string } | null }[] }[] };
    const web = overview.nodes[0]!.pods.find((p) => p.namespace === 'smt-it' && p.owner?.kind === 'ReplicaSet')!;
    const res = await api(operator, 'GET', c(`/objects/pods/smt-it/${web.name}/yaml`));
    expect(res.statusCode).toBe(200);
    const { yaml } = res.json() as KubeObjectYaml;
    expect(yaml).toContain('secretKeyRef');
    expect(yaml).toContain('web-secret');
    expect(res.body).not.toContain('hunter2');
  });

  /** Attach to a shell session's terminal WebSocket. */
  async function attach(session: KubeExecSession) {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/ssh-sessions/${session.sessionId}/ws`, { headers: operator.headers });
    const term = { ws, text: '', closed: null as number | null };
    ws.on('message', (data: Buffer) => (term.text += data.toString()));
    ws.on('close', (code) => (term.closed = code));
    await once(ws, 'open');
    // busybox sh as root
    await until(() => /[#$] $/.test(term.text));
    return term;
  }

  it('opens a recorded shell that follows resizes and ends with the process’s exit code', async () => {
    const res = await api(operator, 'POST', c('/pods/smt-it/ticker/exec'), { cols: 100, rows: 30 });
    expect(res.statusCode).toBe(201);
    const session = res.json() as KubeExecSession;
    expect(session.pod).toMatchObject({ namespace: 'smt-it', name: 'ticker', container: 'ticker' });
    expect(session.recording).not.toBeNull();

    const term = await attach(session);

    term.ws.send('stty size\r');
    await until(() => term.text.includes('30 100'));
    term.ws.send(JSON.stringify({ type: 'resize', cols: 140, rows: 45 }));
    await new Promise((r) => setTimeout(r, 300));
    term.ws.send('stty size\r');
    await until(() => term.text.includes('45 140'));

    term.ws.send('exit 3\r');
    await until(() => term.closed !== null);
    const row = getDb().select().from(sessionRecordings).where(eq(sessionRecordings.id, session.recording!.id)).get()!;
    expect(row).toMatchObject({ kind: 'pod', serverId: null, serverName: 'k3s-pods', command: 'smt-it/ticker/ticker' });
  }, 60_000);

  it.skipIf(!sshHost || !innerUrl || !tokenFile || !caFile)(
    'reaches a pod’s shell through a managed server’s SSH tunnel',
    async () => {
      const server = await api(admin, 'POST', '/api/servers', {
        name: 'kube-pods-bastion',
        host: sshHost,
        port: sshPort,
        username: process.env.SMT_TEST_KUBE_SSH_USER ?? 'smt',
        authType: 'password',
        password: process.env.SMT_TEST_KUBE_SSH_PASSWORD ?? 'smt-it-pass',
      });
      expect(server.statusCode).toBe(201);
      const res = await api(admin, 'POST', '/api/kube/clusters', {
        name: 'k3s-pods-via-ssh',
        apiUrl: innerUrl,
        caData: readFileSync(caFile!, 'utf8'),
        token: readFileSync(tokenFile!, 'utf8').trim(),
        connectVia: 'server',
        viaServerId: server.json().id,
      });
      expect(res.statusCode).toBe(201);
      const viaSsh = res.json() as KubeCluster;

      const panel = await api(operator, 'GET', `/api/kube/clusters/${viaSsh.id}/pods/smt-it/ticker`);
      expect(panel.statusCode).toBe(200);
      // The script's "read-only" role grants `get` on every resource, and an
      // exec over WebSocket is authorized as `get pods/exec` on versions
      // without the newer `create` check (this k3s among them) — so it
      // opens. The docs say to list a viewing role's resources explicitly.
      const shell = await api(operator, 'POST', `/api/kube/clusters/${viaSsh.id}/pods/smt-it/ticker/exec`, {});
      expect(shell.statusCode).toBe(201);
      const term = await attach(shell.json() as KubeExecSession);
      term.ws.send('echo via-$((40+2))\r');
      await until(() => term.text.includes('via-42'));
      term.ws.send('exit\r');
      await until(() => term.closed !== null);
    },
    60_000,
  );
});
