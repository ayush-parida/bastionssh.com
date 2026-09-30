import { Duplex } from 'node:stream';
import type { Client, ClientChannel } from 'ssh2';
import type { DockerTransport } from '@smt/shared';
import { DockerError } from './errors.js';
import { shellCommand } from './shell.js';

/**
 * Byte streams to a server's Docker daemon, over an SSH connection that is
 * already open (docker/pool.ts). Nothing here connects on its own: the SSH
 * client was built with `sshConnectConfig` and connected with `connectSsh`,
 * so host key checks, jump hosts and agents apply to every stream.
 *
 * - `streamlocal`: a `direct-streamlocal@openssh.com` channel to the Unix
 *   socket on the server — sshd connects to the socket as the SSH user.
 * - `dial-stdio`: for sshd with `AllowStreamLocalForwarding no`, an exec
 *   channel running `docker system dial-stdio`, which pipes the same API over
 *   stdin/stdout (Docker CLI ≥ 18.09).
 *
 * Each HTTP connection to the daemon gets a fresh stream (docker/client.ts),
 * so one slow log follow never blocks another request.
 */

export interface DaemonEndpoint {
  transport: DockerTransport;
  socketPath: string;
}

/** How long opening a channel may take before it counts as a timeout. */
export const CHANNEL_OPEN_TIMEOUT_MS = 15_000;

/** Largest stderr kept from a dial-stdio process for its error message. */
const MAX_STDERR = 2048;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string, onLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(new DockerError(`${what} timed out`, 504));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (done) onLate?.(value);
        else resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (!done) reject(err);
      },
    );
  });
}

/**
 * The few socket methods Node's HTTP client may call that an SSH channel
 * lacks. They are no-ops: the channel has no Nagle or keepalive of its own.
 */
export function asSocket<T extends Duplex>(stream: T): T {
  const s = stream as unknown as Record<string, unknown>;
  for (const method of ['setTimeout', 'setNoDelay', 'setKeepAlive', 'ref', 'unref']) {
    if (typeof s[method] !== 'function') s[method] = () => stream;
  }
  return stream;
}

/** A direct-streamlocal channel to `socketPath` on the server. */
export function openStreamLocal(
  client: Client,
  socketPath: string,
  timeoutMs = CHANNEL_OPEN_TIMEOUT_MS,
): Promise<ClientChannel> {
  const opening = new Promise<ClientChannel>((resolve, reject) => {
    try {
      client.openssh_forwardOutStreamLocal(socketPath, (err, channel) => (err ? reject(err) : resolve(channel)));
    } catch (err) {
      // "Not connected": the pooled connection went away under us
      reject(err);
    }
  });
  return withTimeout(opening, timeoutMs, 'Opening the Docker socket', (late) => late.destroy());
}

/**
 * `docker system dial-stdio` on the server, as a duplex stream. The exec
 * channel is wrapped so its end is only reported once the process has exited:
 * when the CLI is missing or cannot reach the daemon, the stream then fails
 * with what it printed on stderr instead of a bare "connection closed".
 */
export function openDialStdio(
  client: Client,
  socketPath: string,
  timeoutMs = CHANNEL_OPEN_TIMEOUT_MS,
): Promise<Duplex> {
  const command = shellCommand(['docker', '--host', `unix://${socketPath}`, 'system', 'dial-stdio']);
  const opening = new Promise<Duplex>((resolve, reject) => {
    try {
      client.exec(command, (err, channel) => (err ? reject(err) : resolve(exitAwareStream(channel))));
    } catch (err) {
      reject(err);
    }
  });
  return withTimeout(opening, timeoutMs, 'Starting docker system dial-stdio', (late) => late.destroy());
}

/** An exec channel as a plain duplex whose end waits for the exit status (see {@link openDialStdio}). */
function exitAwareStream(channel: ClientChannel): Duplex {
  let stderr = '';
  let code: number | null = null;
  let done = false;
  const stream = new Duplex({
    read() {
      channel.resume();
    },
    write(chunk: Buffer, encoding, callback) {
      channel.write(chunk, encoding, callback);
    },
    final(callback) {
      channel.end();
      callback();
    },
    destroy(err, callback) {
      done = true;
      channel.destroy();
      callback(err);
    },
  });
  channel.on('data', (chunk: Buffer) => {
    if (!stream.push(chunk)) channel.pause();
  });
  channel.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8');
  });
  channel.on('exit', (exitCode: number | null) => {
    code = exitCode;
  });
  channel.on('error', (err: Error) => {
    if (!done) stream.destroy(err);
  });
  // ssh2 reports the exit status before the channel closes
  channel.on('close', () => {
    if (done) return;
    done = true;
    if (code !== null && code !== 0) {
      const reason = stderr.trim().slice(0, MAX_STDERR) || `docker system dial-stdio exited with code ${code}`;
      stream.destroy(new DockerError(reason, code === 127 ? 400 : 502));
    } else {
      stream.push(null);
    }
  });
  return stream;
}

/** A fresh stream to the daemon at `endpoint`. */
export function openDaemonStream(client: Client, endpoint: DaemonEndpoint): Promise<Duplex> {
  return endpoint.transport === 'dial-stdio'
    ? openDialStdio(client, endpoint.socketPath)
    : openStreamLocal(client, endpoint.socketPath);
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a short command over the connection and collect its output, capped at
 * `maxBytes` per stream. Used by detection, never with user input spliced in.
 */
export function execCapture(
  client: Client,
  command: string,
  timeoutMs = CHANNEL_OPEN_TIMEOUT_MS,
  maxBytes = 64 * 1024,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    let channel: ClientChannel | undefined;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      channel?.destroy();
      reject(new DockerError('Command on the server timed out', 504));
    }, timeoutMs);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    try {
      client.exec(command, (err, ch) => {
        if (err) return finish(() => reject(err));
        channel = ch;
        let stdout = '';
        let stderr = '';
        let code: number | null = null;
        ch.on('data', (chunk: Buffer) => {
          if (stdout.length < maxBytes) stdout += chunk.toString('utf8');
        });
        ch.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < maxBytes) stderr += chunk.toString('utf8');
        });
        ch.on('exit', (exitCode: number | null) => {
          code = exitCode;
        });
        ch.on('close', () => finish(() => resolve({ code, stdout, stderr })));
        ch.on('error', (e: Error) => finish(() => reject(e)));
      });
    } catch (err) {
      finish(() => reject(err));
    }
  });
}
