import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import dgram from 'dgram';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';
import { and, eq } from 'drizzle-orm';
import type { AuditLogEntry } from '@smt/shared';
import { runMigrations } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { auditForwarders, auditLog } from '../db/schema.js';
import { seedOrg } from '../api/routes/test-utils.js';
import { auditSystem } from './index.js';
import {
  BATCH_SIZE,
  currentCursor,
  deliver,
  deliverWithRetry,
  encryptConfig,
  formatSyslog,
  forwardOrg,
  frameOctetCounted,
  resetBackoff,
  signWebhook,
  targetHint,
  type ForwarderConfig,
} from './forward.js';

const local = { resolve: async () => ({ address: '127.0.0.1', family: 4 as const, internal: true }) };
const publicAddr = { resolve: async () => ({ address: '127.0.0.1', family: 4 as const, internal: false }) };
const fast = { ...local, delays: [0, 0] };

const entry = (over: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  id: 'a1',
  orgId: 'o1',
  actorId: 'u1',
  actorEmail: 'jane@corp.test',
  action: 'server.create',
  resourceType: 'server',
  resourceId: 'srv-1',
  resourceName: 'web-1',
  ipAddress: '203.0.113.9',
  metadata: { note: 'hi "there"]' },
  createdAt: '2026-09-28T10:00:00.123Z',
  ...over,
});

/** Split an RFC 6587 octet-counted stream back into messages. */
function unframe(buf: Buffer): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < buf.length) {
    const space = buf.indexOf(0x20, i);
    const len = Number(buf.subarray(i, space).toString('ascii'));
    out.push(buf.subarray(space + 1, space + 1 + len).toString('utf8'));
    i = space + 1 + len;
  }
  return out;
}

async function listen(server: net.Server | http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as net.AddressInfo).port;
}

describe('formatting', () => {
  it('writes an RFC 5424 message with structured data and the row as JSON', () => {
    const msg = formatSyslog(entry(), 13, 'bastion.example.com');
    // facility 13 (log audit) * 8 + severity 5 (notice)
    expect(msg.startsWith('<109>1 2026-09-28T10:00:00.123Z bastion.example.com bastionssh - server.create ')).toBe(true);
    expect(msg).toContain(
      '[bastionssh@32473 org="o1" actor="jane@corp.test" action="server.create" resourceType="server" resourceId="srv-1" ip="203.0.113.9"]',
    );
    const json = msg.slice(msg.indexOf('﻿') + 1);
    expect(JSON.parse(json)).toEqual(entry());
  });

  it('flags refusals as warnings and escapes structured-data values', () => {
    const msg = formatSyslog(entry({ action: 'user.login_locked', actorEmail: 'a"b]c\\d' }), 4, 'h');
    expect(msg.startsWith('<36>1 ')).toBe(true);
    expect(msg).toContain('actor="a\\"b\\]c\\\\d"');
  });

  it('frames by octet count, in bytes not characters', () => {
    expect(frameOctetCounted('héllo').toString('utf8')).toBe('6 héllo');
  });

  it('never shows a webhook path or secret in the hint', () => {
    expect(targetHint({ type: 'webhook', url: 'https://hooks.example.com/services/T0/B0/secret-token' })).toBe(
      'hooks.example.com/services/T0/B0/…',
    );
    expect(targetHint({ type: 'syslog', host: '::1', port: 6514, protocol: 'tls', facility: 13 })).toBe('tls://[::1]:6514');
  });

  it('signs the timestamp and body together', () => {
    expect(signWebhook('s3cret', '1700000000', '{}')).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signWebhook('s3cret', '1700000000', '{}')).not.toBe(signWebhook('s3cret', '1700000001', '{}'));
  });
});

describe('transports', () => {
  it('sends one UDP datagram per row', async () => {
    const socket = dgram.createSocket('udp4');
    const got: string[] = [];
    await new Promise<void>((r) => socket.bind(0, '127.0.0.1', () => r()));
    socket.on('message', (m) => got.push(m.toString('utf8')));
    const cfg: ForwarderConfig = { type: 'syslog', host: 'logs.test', port: socket.address().port, protocol: 'udp', facility: 13 };
    await deliver(cfg, [entry({ id: 'x1' }), entry({ id: 'x2' })], local);
    await new Promise((r) => setTimeout(r, 50));
    socket.close();
    expect(got).toHaveLength(2);
    expect(got[1]).toContain('"id":"x2"');
  });

  it('sends octet-counted frames over TCP', async () => {
    const chunks: Buffer[] = [];
    const server = net.createServer();
    const closed = new Promise<void>((resolve) => {
      server.on('connection', (s) => {
        s.on('data', (d) => chunks.push(d));
        s.on('end', () => resolve());
      });
    });
    const port = await listen(server);
    await deliver({ type: 'syslog', host: 'logs.test', port, protocol: 'tcp', facility: 13 }, [entry({ id: 't1' }), entry({ id: 't2' })], local);
    await closed;
    server.close();
    const messages = unframe(Buffer.concat(chunks));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/^<109>1 /);
  });

  it('fails cleanly when nothing is listening', async () => {
    const server = net.createServer();
    const port = await listen(server);
    await new Promise((r) => server.close(r));
    await expect(
      deliver({ type: 'syslog', host: 'logs.test', port, protocol: 'tcp', facility: 13 }, [entry()], local),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  describe('TLS', () => {
    let dir: string;
    let cert: string;
    let key: string;
    let available = true;

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-tls-'));
      try {
        execFileSync(
          'openssl',
          [
            'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=logs.test', '-addext', 'subjectAltName=DNS:logs.test',
            '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
          ],
          { stdio: 'ignore' },
        );
        cert = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
        key = fs.readFileSync(path.join(dir, 'key.pem'), 'utf8');
      } catch {
        available = false;
      }
    });

    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    async function tlsServer() {
      const chunks: Buffer[] = [];
      const server = tls.createServer({ cert, key }, (s) => s.on('data', (d) => chunks.push(d)));
      server.on('tlsClientError', () => {});
      const port = await listen(server);
      return { server, port, chunks };
    }

    it('verifies the collector against the CA given, by the name typed', async () => {
      if (!available) return;
      const { server, port, chunks } = await tlsServer();
      await deliver({ type: 'syslog', host: 'logs.test', port, protocol: 'tls', facility: 13, caCert: cert }, [entry()], local);
      await new Promise((r) => setTimeout(r, 50));
      server.close();
      expect(unframe(Buffer.concat(chunks))).toHaveLength(1);
    });

    it('refuses an untrusted certificate or a different name', async () => {
      if (!available) return;
      const { server, port } = await tlsServer();
      await expect(
        deliver({ type: 'syslog', host: 'logs.test', port, protocol: 'tls', facility: 13 }, [entry()], local),
      ).rejects.toThrow(/self[- ]signed|unable to verify/i);
      await expect(
        deliver({ type: 'syslog', host: 'other.test', port, protocol: 'tls', facility: 13, caCert: cert }, [entry()], local),
      ).rejects.toThrow(/altnames|Hostname/i);
      server.close();
    });
  });

  describe('webhook', () => {
    let server: http.Server;
    let port: number;
    let requests: { headers: http.IncomingHttpHeaders; body: string }[];
    let status: number;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          requests.push({ headers: req.headers, body });
          res.writeHead(status, status === 302 ? { location: 'http://169.254.169.254/' } : {}).end();
        });
      });
      port = await listen(server);
    });

    afterAll(() => server.close());

    beforeEach(() => {
      requests = [];
      status = 200;
    });

    it('posts a signed JSON batch, to the checked address, with the name as Host', async () => {
      await deliver({ type: 'webhook', url: `http://audit.internal:${port}/hook?x=1`, secret: 's3cret' }, [entry()], local);
      expect(requests).toHaveLength(1);
      const { headers, body } = requests[0]!;
      expect(headers.host).toBe(`audit.internal:${port}`);
      expect(JSON.parse(body)).toEqual({ source: 'bastionssh', events: [entry()] });
      expect(headers['x-bastionssh-signature']).toBe(signWebhook('s3cret', headers['x-bastionssh-timestamp'] as string, body));
    });

    it('refuses plain HTTP to anything but an allowed internal network', async () => {
      await expect(
        deliver({ type: 'webhook', url: `http://audit.example.com:${port}/hook` }, [entry()], publicAddr),
      ).rejects.toThrow(/must use https/);
      expect(requests).toHaveLength(0);
    });

    it('does not follow redirects, and treats a non-2xx answer as a failure', async () => {
      status = 302;
      await expect(deliver({ type: 'webhook', url: `http://a.internal:${port}/` }, [entry()], local)).rejects.toThrow(
        'Webhook answered HTTP 302',
      );
      expect(requests).toHaveLength(1);
    });

    it('retries a failed delivery', async () => {
      status = 503;
      await expect(deliverWithRetry({ type: 'webhook', url: `http://a.internal:${port}/` }, [entry()], fast)).rejects.toThrow(
        /503/,
      );
      expect(requests).toHaveLength(3);
    });
  });
});

describe('forwardOrg', () => {
  let server: http.Server;
  let port: number;
  let batches: AuditLogEntry[][];
  let status: number;

  beforeAll(async () => {
    await runMigrations();
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        if (status === 200) batches.push((JSON.parse(body) as { events: AuditLogEntry[] }).events);
        res.writeHead(status).end();
      });
    });
    port = await listen(server);
  });

  afterAll(() => server.close());

  beforeEach(() => {
    batches = [];
    status = 200;
    resetBackoff();
  });

  async function setUp() {
    const orgId = seedOrg(`fwd-${Math.random().toString(36).slice(2)}`);
    auditSystem(orgId, 'server.create', 'server', 's0', 'history');
    const now = new Date().toISOString();
    getDb()
      .insert(auditForwarders)
      .values({
        orgId,
        type: 'webhook',
        encryptedConfig: await encryptConfig(orgId, { type: 'webhook', url: `http://collector.internal:${port}/` }),
        targetHint: 'collector.internal',
        ...currentCursor(orgId),
        createdBy: 'u',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return orgId;
  }

  const row = (orgId: string) => getDb().select().from(auditForwarders).where(eq(auditForwarders.orgId, orgId)).get()!;

  it('sends only rows after the cursor, in order, and advances it', async () => {
    const orgId = await setUp();
    auditSystem(orgId, 'server.create', 'server', 's1');
    auditSystem(orgId, 'server.delete', 'server', 's1');
    // Another org's rows are never sent
    auditSystem(seedOrg(`other-${Math.random()}`), 'server.create', 'server', 'x');

    expect(await forwardOrg(orgId, fast)).toBe(2);
    expect(batches.flat().map((e) => e.action)).toEqual(['server.create', 'server.delete']);
    expect(batches.flat().every((e) => e.orgId === orgId)).toBe(true);
    expect(row(orgId)).toMatchObject({ lastStatus: 'ok', lastError: null });

    expect(await forwardOrg(orgId, fast)).toBe(0);
    auditSystem(orgId, 'server.update', 'server', 's1');
    expect(await forwardOrg(orgId, fast)).toBe(1);
  });

  it('sends a backlog in batches', async () => {
    const orgId = await setUp();
    for (let i = 0; i < BATCH_SIZE + 5; i++) auditSystem(orgId, 'server.create', 'server', `s${i}`);
    expect(await forwardOrg(orgId, fast)).toBe(BATCH_SIZE + 5);
    expect(batches.map((b) => b.length)).toEqual([BATCH_SIZE, 5]);
    expect(new Set(batches.flat().map((e) => e.id)).size).toBe(BATCH_SIZE + 5);
  });

  it('keeps the cursor on failure, records and audits it once, backs off, then catches up', async () => {
    const orgId = await setUp();
    auditSystem(orgId, 'server.create', 'server', 's1');
    const before = row(orgId);
    status = 500;
    const t = Date.now();
    expect(await forwardOrg(orgId, { ...fast, now: t })).toBe(0);
    expect(row(orgId)).toMatchObject({
      lastStatus: 'failed',
      lastError: 'Webhook answered HTTP 500',
      cursorCreatedAt: before.cursorCreatedAt,
      cursorRowid: before.cursorRowid,
    });
    const failedRows = () =>
      getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, 'audit.forwarding_failed')))
        .all();
    expect(failedRows()).toHaveLength(1);

    // Backing off: not even tried
    status = 200;
    expect(await forwardOrg(orgId, { ...fast, now: t + 1000 })).toBe(0);
    expect(batches).toHaveLength(0);

    // Later it delivers everything, including the failure notice
    expect(await forwardOrg(orgId, { ...fast, now: t + 60_000 })).toBe(2);
    expect(batches.flat().map((e) => e.action)).toEqual(['server.create', 'audit.forwarding_failed']);
    expect(row(orgId).lastStatus).toBe('ok');
  });

  it('does nothing while disabled', async () => {
    const orgId = await setUp();
    auditSystem(orgId, 'server.create', 'server', 's1');
    getDb().update(auditForwarders).set({ enabled: false }).where(eq(auditForwarders.orgId, orgId)).run();
    expect(await forwardOrg(orgId, fast)).toBe(0);
    expect(batches).toHaveLength(0);
  });
});
