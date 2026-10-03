import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FakeApi } from './fake-api.test-helper.js';

/**
 * Pod logs and exec for the fake API server (fake-api.test-helper.ts), through
 * its `extra` and `onUpgrade` hooks:
 *
 * - `GET …/pods/:name/log` with `container`, `previous`, `follow`,
 *   `tailLines`, `timestamps`; followed logs get what {@link FakePods.log}
 *   appends, and end when {@link FakePods.endLogs} is called;
 * - the exec subresource's WebSocket (real `ws` on the server side, so the
 *   app's own client framing is checked against another implementation):
 *   `v5.channel.k8s.io` and/or `v4.channel.k8s.io`, a tiny shell that echoes
 *   input, records resizes, and exits on `exit N` or when stdin is closed.
 */

export const FAKE_LOG_TIME = '2026-10-03T10:00:00.123456789Z';

export interface FakeExec {
  path: string;
  query: URLSearchParams;
  protocol: string;
  stdin: string;
  resizes: { Width: number; Height: number }[];
  /** The client closed stdin (v5 channel 255). */
  stdinClosed: boolean;
  closed: boolean;
  socket: WebSocket;
}

export interface FakePods {
  /** Lines a container has logged (and, with `previous`, its previous run's). */
  setLogs(ns: string, pod: string, container: string, lines: string[], previous?: string[]): void;
  /** Append a line; followers get it at once. */
  log(ns: string, pod: string, container: string, line: string): void;
  /** End followed logs (the container stopped). */
  endLogs(): void;
  followers(): number;
  execs: FakeExec[];
  /** Protocols the fake accepts, best first. */
  protocols: string[];
  close(): void;
}

const logKey = (ns: string, pod: string, container: string) => `${ns}/${pod}/${container}`;

function status(code: number, reason: string, message: string) {
  return JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Failure', message, reason, code });
}

export function fakePods(api: FakeApi): FakePods {
  const logs = new Map<string, { current: string[]; previous?: string[] }>();
  const following = new Map<ServerResponse, { key: string; timestamps: boolean }>();
  const sockets = new Set<Duplex>();
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (offered) => pods.protocols.find((p) => offered.has(p)) ?? false,
  });

  const format = (line: string, timestamps: boolean) => `${timestamps ? `${FAKE_LOG_TIME} ` : ''}${line}\n`;

  const pods: FakePods = {
    setLogs: (ns, pod, container, current, previous) => logs.set(logKey(ns, pod, container), { current: [...current], previous }),
    log(ns, pod, container, line) {
      const key = logKey(ns, pod, container);
      const entry = logs.get(key) ?? { current: [] };
      entry.current.push(line);
      logs.set(key, entry);
      for (const [res, f] of following) if (f.key === key) res.write(format(line, f.timestamps));
    },
    endLogs() {
      for (const res of following.keys()) res.end();
      following.clear();
    },
    followers: () => following.size,
    execs: [],
    protocols: ['v5.channel.k8s.io', 'v4.channel.k8s.io'],
    close() {
      pods.endLogs();
      for (const s of sockets) s.destroy();
      wss.close();
    },
  };

  api.extra = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const match = /^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/log$/.exec(url.pathname);
    if (!match) return false;
    const [, ns, pod] = match.map(decodeURIComponent) as [string, string, string];
    const container = url.searchParams.get('container') ?? 'app';
    const entry = logs.get(logKey(ns, pod, container));
    const previous = url.searchParams.get('previous') === 'true';
    const timestamps = url.searchParams.get('timestamps') === 'true';
    if (!entry || (previous && !entry.previous)) {
      const message = previous
        ? `previous terminated container "${container}" in pod "${pod}" not found`
        : `container ${container} is not valid for pod ${pod}`;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(status(400, 'BadRequest', message));
      return true;
    }
    let lines = previous ? entry.previous! : entry.current;
    const tail = url.searchParams.get('tailLines');
    if (tail !== null) lines = lines.slice(Math.max(0, lines.length - Number(tail)));
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' });
    res.write(lines.map((l) => format(l, timestamps)).join(''));
    if (url.searchParams.get('follow') === 'true' && !previous) {
      following.set(res, { key: logKey(ns, pod, container), timestamps });
      res.on('close', () => following.delete(res));
    } else {
      res.end();
    }
    void req;
    return true;
  };

  api.onUpgrade = (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'https://fake');
    if (!/^\/api\/v1\/namespaces\/[^/]+\/pods\/[^/]+\/exec$/.test(url.pathname)) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n' + status(404, 'NotFound', 'not found'));
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    wss.handleUpgrade(req, socket, head, (ws) => {
      const exec: FakeExec = {
        path: url.pathname,
        query: url.searchParams,
        protocol: ws.protocol,
        stdin: '',
        resizes: [],
        stdinClosed: false,
        closed: false,
        socket: ws,
      };
      pods.execs.push(exec);
      const send = (channel: number, text: string) => ws.send(Buffer.concat([Buffer.from([channel]), Buffer.from(text)]));
      const exit = (code: number) => {
        send(
          3,
          code === 0
            ? JSON.stringify({ metadata: {}, status: 'Success' })
            : JSON.stringify({
                metadata: {},
                status: 'Failure',
                message: `command terminated with non-zero exit code: error executing command [sh], exit code ${code}`,
                reason: 'NonZeroExitCode',
                details: { causes: [{ reason: 'ExitCode', message: String(code) }] },
              }),
        );
        ws.close(1000);
      };
      ws.on('close', () => (exec.closed = true));
      // A missing binary fails the exec at once, as the kubelet does
      if (url.searchParams.getAll('command')[0] === '/missing') {
        send(3, JSON.stringify({ metadata: {}, status: 'Failure', message: 'exec: "/missing": no such file or directory', reason: 'InternalError' }));
        ws.close(1000);
        return;
      }
      send(1, '$ ');
      ws.on('message', (data: Buffer) => {
        const channel = data[0];
        const payload = data.subarray(1);
        if (channel === 0) {
          const text = payload.toString();
          exec.stdin += text;
          send(1, text);
          const done = /exit (\d+)\r/.exec(exec.stdin);
          if (done) exit(Number(done[1]));
          else if (text.includes('\x04')) exit(0);
          else if (text.includes('oops')) send(2, 'oops on stderr\n');
        } else if (channel === 4) {
          exec.resizes.push(JSON.parse(payload.toString()) as { Width: number; Height: number });
        } else if (channel === 255 && payload[0] === 0) {
          exec.stdinClosed = true;
          exit(0);
        }
      });
    });
  };

  return pods;
}
