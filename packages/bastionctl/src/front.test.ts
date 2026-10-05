import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configuredPorts, proxyHeader, requestReload, serveControl, startFront, type Front } from './front.js';

/**
 * The proxy front (front.ts) with a stand-in for Caddy: a small Node server
 * that reads the PROXY header, answers with the config it started from, and
 * on SIGTERM stops as Go's server does — no new connections, open ones
 * finished, then exit. Under test: config switches while requests keep coming
 * on new and kept-alive connections (none may fail), the client's address
 * reaching Caddy, and a config that does not start leaving the old one
 * serving.
 */

const FAKE_CADDY = `
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
const config = fs.readFileSync(process.argv[2], 'utf8').trim();
if (config.includes('fail')) { console.error('Error: adapting config: bad things'); process.exit(1); }
const server = http.createServer((req, res) => res.end(config + ' ' + req.socket.proxied));
const front = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const nl = buffer.indexOf('\\r\\n');
    if (nl === -1) return;
    socket.off('data', onData);
    socket.proxied = buffer.subarray(0, nl).toString().split(' ')[2];
    socket.unshift(buffer.subarray(nl + 2));
    server.emit('connection', socket);
  };
  socket.on('data', onData);
});
front.listen(Number(process.env.BASTION_HTTP_PORT), '127.0.0.1');
// Caddy's admin API, as the front reads it: a config without a TLS site has no HTTPS listener
const admin = http.createServer((req, res) =>
  res.end(req.url === '/config/' ? JSON.stringify({ apps: { http: { servers: { srv0: { listen: ['127.0.0.1:' + process.env.BASTION_HTTP_PORT] } } } } }) : 'null'),
);
admin.listen(Number(process.env.BASTION_ADMIN_PORT), '127.0.0.1');
process.on('SIGTERM', () => {
  front.close();
  admin.close();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
});
`;

let dir: string;
let front: Front | null;
let port: number;
let base: number;
const config = (text: string) => fs.writeFileSync(path.join(dir, 'Caddyfile'), text);

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port: p } = s.address() as net.AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return p;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-front-'));
  fs.writeFileSync(path.join(dir, 'caddy.mjs'), FAKE_CADDY);
  config('gen-a');
  port = await freePort();
  base = 20000 + Math.floor(Math.random() * 20000);
  front = await startFront({
    config: path.join(dir, 'Caddyfile'),
    listen: [{ port, kind: 'http' }],
    host: '127.0.0.1',
    control: path.join(dir, 'control.sock'),
    caddy: process.execPath,
    caddyArgs: (file) => [path.join(dir, 'caddy.mjs'), file],
    slotPorts: (slot) => ({ http: base + slot, https: base + 10 + slot, admin: base + 20 + slot }),
    drainMs: 500,
    log: () => {},
  });
});

afterEach(async () => {
  await front?.stop();
  front = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

function get(agent: http.Agent | false): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('error', (err: NodeJS.ErrnoException & { reused?: boolean }) => {
      err.reused = req.reusedSocket;
      reject(err);
    });
  });
}

describe('the proxy front', () => {
  it('switches configs while requests keep coming, without failing one', async () => {
    const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 2 });
    const bodies = new Set<string>();
    const failures: string[] = [];
    let count = 0;
    let running = true;
    const loop = async (agent: http.Agent | false) => {
      while (running) {
        try {
          let body: string;
          try {
            body = await get(agent);
          } catch (err) {
            // As browsers, curl and Node's docs do: a request on a kept-alive connection the server closed is sent again
            const e = err as NodeJS.ErrnoException & { reused?: boolean };
            if (!e.reused || e.code !== 'ECONNRESET') throw err;
            body = await get(agent);
          }
          bodies.add(body.split(' ')[0]!);
          count++;
        } catch (err) {
          failures.push((err as Error).message);
        }
      }
    };
    const workers = [loop(false), loop(false), loop(keepAlive), loop(keepAlive)];
    for (const gen of ['gen-b', 'gen-c', 'gen-d', 'gen-e', 'gen-f', 'gen-g']) {
      await new Promise((r) => setTimeout(r, 150));
      config(gen);
      await front!.reload([]);
    }
    await new Promise((r) => setTimeout(r, 800));
    running = false;
    await Promise.all(workers);
    keepAlive.destroy();
    expect(failures).toEqual([]);
    expect(count).toBeGreaterThan(200);
    expect(bodies.has('gen-a')).toBe(true);
    expect(bodies.has('gen-g')).toBe(true);
    // The drained generations stopped; slots were reused
    await new Promise((r) => setTimeout(r, 300));
    expect(front!.generations().map(({ generation, serving }) => ({ generation, serving }))).toEqual([{ generation: 7, serving: true }]);
  }, 30_000);

  it('passes the client’s address to Caddy in a PROXY header', async () => {
    expect(await get(false)).toBe('gen-a 127.0.0.1');
    expect(proxyHeader({ remoteAddress: '::ffff:203.0.113.7', remotePort: 51000, localAddress: '::ffff:172.18.0.2', localPort: 443 })).toBe(
      'PROXY TCP4 203.0.113.7 172.18.0.2 51000 443\r\n',
    );
    expect(proxyHeader({ remoteAddress: '2001:db8::1', remotePort: 51000, localAddress: '2001:db8::2', localPort: 443 })).toBe('PROXY TCP6 2001:db8::1 2001:db8::2 51000 443\r\n');
    expect(proxyHeader({ remoteAddress: undefined, remotePort: undefined, localAddress: '::1', localPort: 80 })).toBe('PROXY UNKNOWN\r\n');
  });

  it('keeps the old config serving when the new one does not start, and says why', async () => {
    config('fail');
    await expect(front!.reload([])).rejects.toThrow(/Caddy did not start with the new config \(exit code 1\):\nError: adapting config: bad things/);
    expect(await get(false)).toBe('gen-a 127.0.0.1');
    expect(front!.generations().map(({ generation, serving }) => ({ generation, serving }))).toEqual([{ generation: 1, serving: true }]);
  });

  it('starts and switches when the config has no listener for one of its ports (no TLS site yet)', async () => {
    // A server set up with no app: Caddy has only its HTTP redirect site, and nothing on the HTTPS port
    const httpsPort = await freePort();
    const other = await startFront({
      config: path.join(dir, 'Caddyfile'),
      listen: [
        { port: await freePort(), kind: 'http' },
        { port: httpsPort, kind: 'https' },
      ],
      host: '127.0.0.1',
      control: path.join(dir, 'other.sock'),
      caddy: process.execPath,
      caddyArgs: (file) => [path.join(dir, 'caddy.mjs'), file],
      slotPorts: (slot) => ({ http: base + 30 + slot, https: base + 40 + slot, admin: base + 50 + slot }),
      readyMs: 5000,
      log: () => {},
    });
    try {
      expect(await configuredPorts(base + 50)).toEqual(new Set([base + 30]));
      config('gen-b');
      await other.reload([]);
      expect(other.generations().find((g) => g.serving)?.generation).toBe(2);
      // Nothing behind the HTTPS port: the connection is closed, as an unknown name's would be
      await new Promise<void>((resolve) => {
        const c = net.connect({ host: '127.0.0.1', port: httpsPort });
        c.on('close', () => resolve());
        c.on('error', () => {});
      });
    } finally {
      await other.stop();
    }
    // Nothing answering on the admin port: unknown, so the front keeps waiting for the port itself
    expect(await configuredPorts(await freePort())).toBeNull();
    // nginx mode with no app: a config without an HTTP app listens on nothing
    const empty = http.createServer((req, res) => res.end(req.url === '/config/' ? JSON.stringify({ admin: { listen: 'localhost:2019' } }) : 'null'));
    await new Promise<void>((resolve) => empty.listen(0, '127.0.0.1', resolve));
    try {
      expect(await configuredPorts((empty.address() as net.AddressInfo).port)).toEqual(new Set());
    } finally {
      empty.close();
    }
  });

  it('answers reload over its control socket, with progress and the result', async () => {
    const control = path.join(dir, 'control.sock');
    const server = serveControl(front!, control);
    try {
      const lines: string[] = [];
      config('gen-b');
      expect(await requestReload(control, [], { log: (l) => lines.push(l), error: (l) => lines.push(`error: ${l}`) })).toBe(0);
      expect(lines).toEqual(['Started Caddy generation 2', 'Caddy generation 2 serves; generation 1 finishes its open connections']);
      expect(await get(false)).toBe('gen-b 127.0.0.1');
      // With the hash of the text bastionctl validated, that text is what starts
      config('gen-c');
      expect(await requestReload(control, [], { log: () => {}, error: (l) => lines.push(`error: ${l}`) }, createHash('sha256').update('gen-c').digest('hex'))).toBe(0);
      expect(await get(false)).toBe('gen-c 127.0.0.1');
      config('fail');
      lines.length = 0;
      expect(await requestReload(control, [], { log: (l) => lines.push(l), error: (l) => lines.push(`error: ${l}`) })).toBe(1);
      expect(lines.at(-1)).toMatch(/^error: Caddy did not start with the new config/);
      expect(await requestReload(path.join(dir, 'nobody.sock'), [], { log: () => {}, error: (l) => lines.push(l) })).toBe(1);
      expect(lines.at(-1)).toMatch(/The proxy front is not running \(ENOENT\)/);
    } finally {
      server.close();
    }
  });
});
