import { Duplex, PassThrough, Writable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { kubePermissions, type Role } from '@smt/shared';
import { canAccessCluster } from '../auth/cluster-access.js';
import { getDb } from '../db/index.js';
import { memberships } from '../db/schema.js';
import { SSHBroker, type TerminalChannel } from '../ssh/broker.js';
import type { KubeClient } from './client.js';
import { kubeSettings } from './settings.js';
import type { WebSocketConnection } from './websocket.js';

/**
 * A shell in a pod's container (K4, spec §2.10), over the exec subresource's
 * WebSocket — `v5.channel.k8s.io`, or `v4.channel.k8s.io` on older API
 * servers — on the same verified TLS route as every other call (client.ts
 * `exec`). Each binary message starts with its channel:
 *
 *   0 stdin → · 1 stdout ← · 2 stderr ← · 3 status ← · 4 resize → · 255 close →
 *
 * Status (3) is a `metav1.Status` once the process ends: `Success`, or
 * `NonZeroExitCode` with the code in its causes. Resize (4) is
 * `{"Width":…,"Height":…}`. Close (255, v5 only) ends stdin without ending
 * the session.
 *
 * {@link openPodShell} adapts a session to the shape of an SSH shell channel,
 * so the terminal broker (ssh/broker.ts) runs it like a Docker container
 * shell — the same WebSocket, buffering, reaping, recording and revocation.
 */

export const CHANNEL = { stdin: 0, stdout: 1, stderr: 2, status: 3, resize: 4, close: 255 } as const;

/** Bash when the container has it, else sh — one exec, no probing round trips. */
export const DEFAULT_POD_SHELL = ['/bin/sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'];

/** After the terminal closes, how long to wait for the process to report its exit. */
const EXIT_WAIT_MS = 3_000;

export interface ExecSession {
  /** The protocol the API server picked. */
  protocol: string;
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  resize(cols: number, rows: number): void;
  /** End the process's input (v5; v4 cannot, the session must close instead). */
  endInput(): void;
  /** Close the WebSocket (idempotent). */
  close(): void;
  /**
   * The exit code once the process ends: its code, 0 for success, null when
   * the connection ended without saying.
   */
  exited: Promise<number | null>;
  /** The API server's message for a process that failed to start or ended with an error. */
  readonly failure: string | null;
}

interface ExecStatus {
  status?: unknown;
  message?: unknown;
  reason?: unknown;
  details?: { causes?: { reason?: unknown; message?: unknown }[] };
}

/** The exit code and message a status channel message carries. */
export function parseExecStatus(text: string): { exitCode: number | null; message: string | null } {
  let status: ExecStatus;
  try {
    status = JSON.parse(text) as ExecStatus;
  } catch {
    // v1–v3 sent plain text; anything unreadable is a failure without a code
    return { exitCode: null, message: text.trim() || null };
  }
  if (status.status === 'Success') return { exitCode: 0, message: null };
  const message = typeof status.message === 'string' ? status.message : null;
  if (status.reason === 'NonZeroExitCode') {
    const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
    const code = Number(cause?.message);
    return { exitCode: Number.isInteger(code) ? code : null, message };
  }
  return { exitCode: null, message };
}

/** The exec session over an upgraded WebSocket (see the module comment). */
export function execSession(ws: WebSocketConnection, protocol: string): ExecSession {
  const v5 = protocol.startsWith('v5.');
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let failure: string | null = null;
  let exitCode: number | null = null;
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => (resolveExit = resolve));

  const frame = (channel: number, data: Buffer | string) =>
    ws.send(Buffer.concat([Buffer.from([channel]), typeof data === 'string' ? Buffer.from(data) : data]));

  // Output the browser is not reading yet holds the socket back
  const pushTo = (stream: PassThrough, data: Buffer) => {
    if (!stream.write(data)) {
      ws.pause();
      stream.once('drain', () => ws.resume());
    }
  };

  ws.on('message', (message: Buffer) => {
    if (message.length === 0) return;
    const channel = message[0]!;
    const data = message.subarray(1);
    if (channel === CHANNEL.stdout) {
      if (data.length) pushTo(stdout, data);
    } else if (channel === CHANNEL.stderr) {
      if (data.length) pushTo(stderr, data);
    } else if (channel === CHANNEL.status) {
      if (!data.length) return;
      const parsed = parseExecStatus(data.toString('utf8'));
      exitCode = parsed.exitCode;
      if (parsed.exitCode === null || parsed.exitCode !== 0) failure = parsed.message;
    }
  });
  ws.on('error', () => {
    /* the close that follows ends the session */
  });
  ws.once('close', () => {
    stdout.end();
    stderr.end();
    resolveExit(exitCode);
  });

  const stdin = new Writable({
    write(chunk: Buffer, _enc, callback) {
      frame(CHANNEL.stdin, chunk);
      callback();
    },
    final(callback) {
      if (v5) frame(CHANNEL.close, Buffer.from([CHANNEL.stdin]));
      callback();
    },
  });
  stdin.on('error', () => {});

  return {
    protocol,
    stdin,
    stdout,
    stderr,
    resize(cols, rows) {
      frame(CHANNEL.resize, JSON.stringify({ Width: Math.max(1, cols | 0), Height: Math.max(1, rows | 0) }));
    },
    endInput() {
      if (v5 && ws.isOpen) frame(CHANNEL.close, Buffer.from([CHANNEL.stdin]));
    },
    close() {
      ws.close();
    },
    exited,
    get failure() {
      return failure;
    },
  };
}

/**
 * The session as a {@link TerminalChannel}: output (stdout, and stderr when
 * there is no TTY) is readable, input goes to the process, `setWindow`
 * resizes its TTY. A process that failed to start says why in the terminal.
 */
export function podShellChannel(session: ExecSession): TerminalChannel {
  const channel = new Duplex({
    read() {
      session.stdout.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      if (session.stdin.writable) session.stdin.write(chunk);
      callback();
    },
    final(callback) {
      session.endInput();
      callback();
    },
    destroy(err, callback) {
      session.close();
      callback(err);
    },
  }) as TerminalChannel;
  channel.stderr = session.stderr;
  channel.setWindow = (rows: number, cols: number) => session.resize(cols, rows);

  session.stdout.on('data', (chunk: Buffer) => {
    if (!channel.push(chunk)) session.stdout.pause();
  });
  session.stdout.once('end', () => {
    void session.exited.then(() => {
      const why = session.failure;
      if (why && !channel.destroyed) channel.push(`\r\n\x1b[31m[${why.replace(/\r?\n/g, '\r\n')}]\x1b[0m\r\n`);
      channel.push(null);
    });
  });
  // The process exited and its output was read: the session is over
  channel.once('end', () => {
    if (!channel.destroyed) channel.destroy();
  });
  return channel;
}

export interface PodShell {
  protocol: string;
  channel: TerminalChannel;
  /** End the shell (idempotent) and resolve with its exit code, null when it did not say in time. */
  close(): Promise<number | null>;
}

/** Open `cmd` with a TTY in `container`, sized `cols`×`rows`. */
export async function openPodShell(
  client: KubeClient,
  target: { namespace: string; pod: string; container: string },
  opts: { cmd: string[]; cols: number; rows: number; signal?: AbortSignal },
): Promise<PodShell> {
  const session = await client.exec(target.namespace, target.pod, {
    container: target.container,
    command: opts.cmd,
    tty: true,
    signal: opts.signal,
  });
  // The exec takes no size; the first resize sets it
  session.resize(opts.cols, opts.rows);
  const channel = podShellChannel(session);
  let closing: Promise<number | null> | null = null;
  return {
    protocol: session.protocol,
    channel,
    close() {
      closing ??= (async () => {
        // As near as the API gets to a terminal window closing: interrupt
        // what runs in the foreground, ^D the shell, end its input (v5)
        if (!channel.destroyed && session.stdin.writable) {
          session.stdin.write('\x03\x04');
          session.endInput();
        }
        const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), EXIT_WAIT_MS).unref?.());
        const code = await Promise.race([session.exited, timer]);
        session.close();
        if (!channel.destroyed) channel.destroy();
        return code;
      })();
      return closing;
    },
  };
}

/**
 * Close pod shells whose owner may no longer open them — after a role change,
 * an admin switching `operatorsCanExec` off, or losing the cluster. Scoped to
 * one org; `userId` narrows it to one member. Returns how many were closed.
 */
export function closeDisallowedPodShells(orgId: string, userId?: string): number {
  const settings = kubeSettings(orgId);
  const allowed = new Map<string, boolean>();
  const mayExec = (user: string, clusterId: string) => {
    const key = `${user}\u0000${clusterId}`;
    let ok = allowed.get(key);
    if (ok === undefined) {
      const member = getDb()
        .select({ role: memberships.role, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.userId, user), eq(memberships.orgId, orgId)))
        .get();
      ok =
        !!member &&
        member.status === 'active' &&
        kubePermissions(member.role as Role, settings).exec &&
        canAccessCluster({ orgId, userId: user }, clusterId);
      allowed.set(key, ok);
    }
    return ok;
  };
  return SSHBroker.closeWhere(
    (s) => s.pod !== null && s.orgId === orgId && (!userId || s.userId === userId) && !mayExec(s.userId, s.pod.clusterId),
  );
}

/** Close every pod shell on a cluster (edited or removed). */
export function closeClusterShells(clusterId: string): number {
  return SSHBroker.closeWhere((s) => s.pod !== null && s.pod.clusterId === clusterId);
}
