import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { KubeLogEvent } from '@smt/shared';
import type { EventStream } from '../api/sse.js';
import { runMigrations } from '../db/migrate.js';
import { seedOrg } from '../api/routes/test-utils.js';
import { clientFor } from './service.js';
import { FAKE_TOKEN, pod, startFakeApi, type FakeApi } from './fake-api.test-helper.js';
import { FAKE_LOG_TIME, fakePods, type FakePods } from './fake-pod-api.test-helper.js';
import { CA_CERT } from './test-certs.test-helper.js';
import { defaultContainer, logLimits, logLineReader, pipeLogsToSse, podContainerNames, resolveContainer } from './logs.js';
import type { KubeObject } from './client.js';

/**
 * Pod logs (logs.ts, client.ts `logs`): containers picked like kubectl, lines
 * with their timestamps, and streaming against the fake API server — tail,
 * previous, follow, batching, the size cap and the browser going away.
 */

/** A stand-in SSE stream that collects what is sent. */
function collector() {
  const events: KubeLogEvent[] = [];
  const controller = new AbortController();
  let closed = false;
  const sse: EventStream<KubeLogEvent> = {
    signal: controller.signal,
    send: (e) => {
      if (!closed) events.push(e);
    },
    fail: (err) => {
      events.push({ type: 'error', error: (err as Error).message });
      closed = true;
    },
    end: () => {
      closed = true;
      controller.abort();
    },
    get closed() {
      return closed;
    },
    backpressured: false,
    onDrain: () => {},
  };
  const lines = () => events.flatMap((e) => (e.type === 'logs' ? e.lines.map((l) => l.text) : []));
  return { sse, events, lines, abort: () => controller.abort() };
}

const until = async (check: () => boolean, ms = 3000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('containers', () => {
  const twoContainers = {
    ...pod('shop', 'web-1'),
    spec: { initContainers: [{ name: 'migrate' }], containers: [{ name: 'app' }, { name: 'proxy' }] },
  } as unknown as KubeObject;

  it('lists every container and picks the first app container by default', () => {
    expect(podContainerNames(twoContainers)).toEqual(['migrate', 'app', 'proxy']);
    expect(defaultContainer(twoContainers)).toBe('app');
  });

  it('follows the default-container annotation, when it names a real container', () => {
    const annotated = { ...twoContainers, metadata: { ...twoContainers.metadata, annotations: { 'kubectl.kubernetes.io/default-container': 'proxy' } } };
    expect(defaultContainer(annotated)).toBe('proxy');
    annotated.metadata.annotations = { 'kubectl.kubernetes.io/default-container': 'gone' };
    expect(defaultContainer(annotated)).toBe('app');
  });

  it('refuses a container the pod does not have', () => {
    expect(resolveContainer(twoContainers, 'migrate')).toBe('migrate');
    expect(() => resolveContainer(twoContainers, 'nope')).toThrow(/no container named nope/);
  });
});

describe('logLineReader', () => {
  it('splits lines across chunks and takes off the kubelet’s timestamp', () => {
    const reader = logLineReader(true);
    expect(reader.push(Buffer.from(`${FAKE_LOG_TIME} hel`))).toEqual([]);
    expect(reader.push(Buffer.from('lo\r\n2026-10-03T10:00:01+02:00 two\nno time here\n'))).toEqual([
      { time: FAKE_LOG_TIME, text: 'hello' },
      { time: '2026-10-03T10:00:01+02:00', text: 'two' },
      { text: 'no time here' },
    ]);
    expect(reader.flush()).toEqual([]);
  });

  it('keeps lines as they are without timestamps', () => {
    const reader = logLineReader(false);
    expect(reader.push(Buffer.from(`${FAKE_LOG_TIME} x\nlast`))).toEqual([{ text: `${FAKE_LOG_TIME} x` }]);
    expect(reader.flush()).toEqual([{ text: 'last' }]);
  });
});

describe('pod logs against the fake API', () => {
  let api: FakeApi;
  let pods: FakePods;
  let orgId: string;
  const client = () =>
    clientFor({
      orgId,
      apiUrl: api.url,
      caData: CA_CERT,
      credential: { type: 'token', token: FAKE_TOKEN },
      connectVia: 'direct',
      viaServerId: null,
      viaAgentId: null,
    });

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('kube-logs');
    api = await startFakeApi();
    pods = fakePods(api);
    pods.setLogs('shop', 'web-1', 'app', ['one', 'two', 'three'], ['crashed: boom']);
  });

  afterAll(async () => {
    pods.close();
    await api.close();
  });

  afterEach(() => {
    logLimits.maxStreamBytes = 64 * 1024 * 1024;
  });

  it('reads a tail with timestamps and ends', async () => {
    const res = await client().logs('shop', 'web-1', { container: 'app', tailLines: 2, timestamps: true });
    const out = collector();
    await pipeLogsToSse(res, out.sse, true);
    expect(out.lines()).toEqual(['two', 'three']);
    expect(out.events.find((e) => e.type === 'logs')).toMatchObject({ lines: [{ time: FAKE_LOG_TIME }, { time: FAKE_LOG_TIME }] });
    expect(out.events.at(-1)).toEqual({ type: 'end' });
    expect(api.requests.at(-1)).toMatch(/\/pods\/web-1\/log\?container=app&tailLines=2&timestamps=true$/);
  });

  it('reads the previous run, and says when there is none', async () => {
    const res = await client().logs('shop', 'web-1', { container: 'app', previous: true });
    const out = collector();
    await pipeLogsToSse(res, out.sse, false);
    expect(out.lines()).toEqual(['crashed: boom']);
    pods.setLogs('shop', 'fresh', 'app', ['hi']);
    await expect(client().logs('shop', 'fresh', { container: 'app', previous: true })).rejects.toThrow(/previous terminated container/);
  });

  it('follows new lines until the container stops', async () => {
    const res = await client().logs('shop', 'web-1', { container: 'app', follow: true, tailLines: 0 });
    const out = collector();
    const done = pipeLogsToSse(res, out.sse, false);
    await until(() => pods.followers() === 1);
    pods.log('shop', 'web-1', 'app', 'live 1');
    pods.log('shop', 'web-1', 'app', 'live 2');
    await until(() => out.lines().length === 2);
    expect(out.lines()).toEqual(['live 1', 'live 2']);
    pods.endLogs();
    await done;
    expect(out.events.at(-1)).toEqual({ type: 'end' });
  });

  it('stops reading when the browser goes away', async () => {
    const res = await client().logs('shop', 'web-1', { container: 'app', follow: true, tailLines: 0 });
    const out = collector();
    const done = pipeLogsToSse(res, out.sse, false);
    await until(() => pods.followers() === 1);
    out.abort();
    await done;
    await until(() => pods.followers() === 0);
  });

  it('ends a followed stream at the size cap, saying it was truncated', async () => {
    logLimits.maxStreamBytes = 50;
    const res = await client().logs('shop', 'web-1', { container: 'app', follow: true, tailLines: 0 });
    const out = collector();
    const done = pipeLogsToSse(res, out.sse, false);
    await until(() => pods.followers() === 1);
    for (let i = 0; i < 10; i++) pods.log('shop', 'web-1', 'app', `a fairly long line number ${i}`);
    await done;
    expect(out.events.at(-1)).toEqual({ type: 'end', truncated: true });
    await until(() => pods.followers() === 0);
  });
});
