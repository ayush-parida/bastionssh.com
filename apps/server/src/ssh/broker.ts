import { Client } from 'ssh2';
import type { ClientChannel } from 'ssh2';
import { vault } from '../vault/index.js';
import type { WebSocket } from 'ws';
import type { FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import logger from '../logger.js';
import { HostKeyMismatchError, sshConnectConfig, type SshAuth, type SshTarget } from './host-keys.js';
import { connectSsh, type JumpOptions } from './jump.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SessionMeta {
  server: { id: string; host: string; port: number; username: string };
  key?: { id: string; encryptedPrivateKey: string };
  password?: string; // plaintext, decrypted by caller
  userId: string;
  orgId: string;
  cols: number;
  rows: number;
}

/** Who is asking for a session; it must match the creator. */
export interface SessionOwner {
  userId: string;
  orgId: string;
}

interface ActiveSession {
  meta: SessionMeta;
  client: Client;
  /** Resolves to the shell stream once SSH is ready */
  streamPromise: Promise<ClientChannel>;
  socket?: WebSocket;
  /** Buffers output until a socket attaches */
  outputBuffer: Buffer[];
  /** Reference to the buffer listener so attach() can remove it */
  bufferFn?: (data: Buffer) => void;
  /** Closes the session if no socket (re)attaches within the grace period */
  reapTimer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, ActiveSession>();

/** How long a session may sit with no WebSocket attached before it is closed. */
export const DETACHED_GRACE_MS = 60_000;

/** Output cap per exec call; anything beyond is dropped and flagged. */
const MAX_EXEC_STDOUT = 64_000;
const MAX_EXEC_STDERR = 8_000;
const TRUNCATED_MARKER = '\n[output truncated]';

/** Accumulates channel output up to `limit` bytes, discarding the rest. */
function cappedCollector(limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    push(data: Buffer) {
      if (size >= limit) {
        truncated = true;
        return;
      }
      const room = limit - size;
      const chunk = data.length > room ? data.subarray(0, room) : data;
      if (chunk !== data) truncated = true;
      chunks.push(chunk);
      size += chunk.length;
    },
    text() {
      const out = Buffer.concat(chunks).toString();
      return truncated ? out + TRUNCATED_MARKER : out;
    },
  };
}

function scheduleReap(id: string, session: ActiveSession) {
  clearTimeout(session.reapTimer);
  session.reapTimer = setTimeout(() => {
    if (sessions.get(id) === session && !session.socket) {
      logger.info({ sessionId: id }, 'Closing detached SSH session');
      destroy(id);
    }
  }, DETACHED_GRACE_MS);
  session.reapTimer.unref?.();
}

function destroy(sessionId: string) {
  const session = sessions.get(sessionId);
  if (session) {
    clearTimeout(session.reapTimer);
    session.client.end();
    session.socket?.close();
    sessions.delete(sessionId);
  }
}

/**
 * Look up a session only if it belongs to this user in this org. A mismatch
 * is indistinguishable from an unknown id.
 */
export function getSessionForUser(sessionId: string, userId: string, orgId: string) {
  const session = sessions.get(sessionId);
  if (!session || session.meta.userId !== userId || session.meta.orgId !== orgId) {
    return undefined;
  }
  return { id: sessionId, userId, orgId, server: session.meta.server };
}

function ownedSession(sessionId: string, owner: SessionOwner) {
  return getSessionForUser(sessionId, owner.userId, owner.orgId)
    ? sessions.get(sessionId)
    : undefined;
}

async function createSession(meta: SessionMeta): Promise<string> {
  const id = nanoid();
  const client = new Client();

  const privateKey = meta.key
    ? await vault.decrypt(meta.key.encryptedPrivateKey, meta.key.id)
    : undefined;
  const password = meta.password;

  if (!privateKey && !password) {
    throw new Error('No authentication method available');
  }

  const { config: connectConfig, guard } = sshConnectConfig(
    meta.server,
    privateKey ? { privateKey } : { password },
    'terminal',
  );

  const streamPromise = new Promise<ClientChannel>((resolve, reject) => {
    client
      .on('ready', () => {
        client.shell(
          { cols: meta.cols, rows: meta.rows, term: 'xterm-256color' },
          (err, stream) => {
            if (err) {
              reject(err);
              client.end();
              return;
            }
            resolve(stream);
          },
        );
      })
      .on('error', (err) => {
        const cause = guard.error(err);
        if (!(cause instanceof HostKeyMismatchError)) {
          logger.error({ err, sessionId: id }, 'SSH connection error');
        }
        reject(cause);
        clearTimeout(session.reapTimer);
        sessions.delete(id);
      });
    connectSsh(client, meta.server, connectConfig, 'terminal', { actorUserId: meta.userId });
  });

  const session: ActiveSession = { meta, client, streamPromise, outputBuffer: [] };
  sessions.set(id, session);
  // A session that is never attached must not live forever
  scheduleReap(id, session);

  // Buffer output until a WebSocket attaches
  streamPromise
    .then((stream) => {
      const bufferFn = (data: Buffer) => {
        session.outputBuffer.push(data);
        // Cap buffer at 256 KB
        let size = session.outputBuffer.reduce((s, b) => s + b.length, 0);
        while (size > 256 * 1024 && session.outputBuffer.length > 0) {
          size -= session.outputBuffer.shift()!.length;
        }
      };
      session.bufferFn = bufferFn;
      stream.on('data', bufferFn);
      stream.stderr.on('data', bufferFn);
      // Without a listener, a channel error (e.g. write after the remote closed it) would crash the process
      stream.on('error', (err: Error) => {
        logger.warn({ err, sessionId: id }, 'SSH shell stream error');
        destroy(id);
      });
      stream.stderr.on('error', (err: Error) => {
        logger.warn({ err, sessionId: id }, 'SSH shell stderr error');
      });
      stream.once('close', () => {
        clearTimeout(session.reapTimer);
        session.socket?.close();
        session.client.end();
        sessions.delete(id);
      });
    })
    .catch(() => {
      clearTimeout(session.reapTimer);
      sessions.delete(id);
    });

  return id;
}

async function attach(sessionId: string, socket: WebSocket, req: FastifyRequest) {
  const session = ownedSession(sessionId, { userId: req.user.id, orgId: req.orgId });
  if (!session) {
    socket.close(4404, 'Session not found');
    return;
  }
  clearTimeout(session.reapTimer);

  // Detach any previous socket (e.g. React StrictMode double-mount)
  if (
    session.socket &&
    session.socket !== socket &&
    session.socket.readyState === session.socket.OPEN
  ) {
    session.socket.close();
  }
  session.socket = socket;

  let stream: ClientChannel;
  try {
    stream = await session.streamPromise;
  } catch (err: unknown) {
    if (err instanceof HostKeyMismatchError) {
      // A close reason is capped at 123 bytes — the full explanation goes as a
      // message first, then a dedicated close code the browser can recognise.
      sendHostKeyMismatch(socket, err);
      sessions.delete(sessionId);
      return;
    }
    const msg = err instanceof Error ? err.message : 'SSH connection failed';
    socket.close(4500, msg);
    sessions.delete(sessionId);
    return;
  }

  // The socket may have gone away while SSH was still connecting
  if (socket.readyState !== socket.OPEN) {
    if (session.socket === socket) {
      session.socket = undefined;
      scheduleReap(sessionId, session);
    }
    return;
  }

  // Remove the buffer listener now that a live socket is attached
  if (session.bufferFn) {
    stream.removeListener('data', session.bufferFn);
    stream.stderr.removeListener('data', session.bufferFn);
    session.bufferFn = undefined;
  }

  // Wire: SSH stream → WebSocket (flush buffer + send live data)
  const onData = (data: Buffer) => {
    if (socket.readyState === socket.OPEN) socket.send(data);
  };

  // Flush buffered output
  for (const chunk of session.outputBuffer) {
    if (socket.readyState === socket.OPEN) socket.send(chunk);
  }
  session.outputBuffer = [];

  // Register live data forwarding
  stream.on('data', onData);
  stream.stderr.on('data', onData);

  // Wire: WebSocket → SSH stream
  socket.on('message', (msg: any) => {
    // The remote may already have closed the channel; writing then would error
    if (!stream.writable) return;
    const data = msg instanceof Buffer ? msg : Buffer.from(msg as string);
    try {
      const parsed = JSON.parse(data.toString()) as { type: string; cols?: number; rows?: number };
      if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
        stream.setWindow(parsed.rows, parsed.cols, 0, 0);
        return;
      }
    } catch {
      /* raw input */
    }
    stream.write(data);
  });

  socket.on('close', () => {
    // Remove live-data listeners; stream stays open for potential re-attach
    stream.removeListener('data', onData);
    stream.stderr.removeListener('data', onData);
    if (session.socket === socket) {
      session.socket = undefined;
      scheduleReap(sessionId, session);
    }
  });
}

/** WebSocket close code for a connection refused because the host key changed. */
export const WS_CLOSE_HOST_KEY_MISMATCH = 4409;

function sendHostKeyMismatch(socket: WebSocket, err: HostKeyMismatchError) {
  if (socket.readyState === socket.OPEN) {
    socket.send(
      `\r\n\x1b[31m[Host key verification failed]\x1b[0m\r\n` +
        `The SSH host key changed. Expected ${err.expected}\r\n` +
        `but the host presented ${err.presented}.\r\n` +
        `The connection was refused before any credentials were sent.\r\n`,
    );
  }
  socket.close(WS_CLOSE_HOST_KEY_MISMATCH, 'HOST_KEY_MISMATCH');
}

/** Close a session the caller owns; unknown or foreign ids are a no-op. */
async function close(sessionId: string, owner: SessionOwner) {
  if (ownedSession(sessionId, owner)) destroy(sessionId);
}

/** What to close when a user's access is revoked. */
export interface RevokeScope {
  /** Only sessions in this org; omit for every org. */
  orgId?: string;
  /** Leave sessions on these servers open (the ones the user may still use). */
  keepServerIds?: Iterable<string>;
}

/**
 * Close a user's live terminals after their access changes — suspension,
 * removal, a narrowed server grant, a password reset or "sign out everywhere".
 * The WebSocket is closed with a policy code so the browser can say why.
 * Returns how many sessions were closed.
 */
function closeForUser(userId: string, scope: RevokeScope = {}): number {
  const keep = new Set(scope.keepServerIds ?? []);
  let closed = 0;
  for (const [id, session] of [...sessions]) {
    if (session.meta.userId !== userId) continue;
    if (scope.orgId && session.meta.orgId !== scope.orgId) continue;
    const serverId = session.meta.server.id;
    if (serverId && keep.has(serverId)) continue;
    try {
      session.socket?.close(4403, 'Access revoked');
    } catch {
      /* already closed */
    }
    destroy(id);
    closed++;
  }
  return closed;
}

/**
 * Execute a command on an existing session's SSH connection (separate channel).
 * The interactive shell stream is unaffected.
 */
async function exec(
  sessionId: string,
  command: string,
  timeoutMs = 30_000,
  owner?: SessionOwner,
): Promise<ExecResult> {
  const session = owner ? ownedSession(sessionId, owner) : sessions.get(sessionId);
  if (!session) throw new Error('Session not found');

  return new Promise<ExecResult>((resolve, reject) => {
    let channel: ClientChannel | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('Command timed out'));
      // Close the channel so a never-ending command stops producing output
      channel?.close();
    }, timeoutMs);

    session.client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      channel = stream;
      if (timedOut) {
        stream.close();
        return;
      }

      const stdout = cappedCollector(MAX_EXEC_STDOUT);
      const stderr = cappedCollector(MAX_EXEC_STDERR);
      let exitCode = 0;

      stream.on('data', (data: Buffer) => stdout.push(data));
      stream.stderr.on('data', (data: Buffer) => stderr.push(data));
      stream.on('error', () => {
        /* surfaced via 'close' / timeout */
      });
      stream.on('exit', (code: number | null) => {
        exitCode = code ?? 0;
      });
      stream.on('close', () => {
        clearTimeout(timer);
        resolve({ stdout: stdout.text(), stderr: stderr.text(), exitCode });
      });
    });
  });
}

/**
 * Open a one-shot SSH connection to run a command and return its output.
 * Used by the AI agent when there is no active interactive session.
 */
export async function execOnServer(
  server: SshTarget,
  authOptions: SshAuth,
  command: string,
  timeoutMs = 30_000,
  /** Who the command runs for; any jump hop is audited under them. */
  options: JumpOptions = {},
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const client = new Client();
    const { config: connectConfig, guard } = sshConnectConfig(server, authOptions, 'exec');
    const timer = setTimeout(() => {
      client.end();
      reject(new Error('Command timed out'));
    }, timeoutMs);

    client
      .on('ready', () => {
        client.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            client.end();
            reject(err);
            return;
          }

          const stdout = cappedCollector(MAX_EXEC_STDOUT);
          const stderr = cappedCollector(MAX_EXEC_STDERR);
          let exitCode = 0;

          stream.on('data', (data: Buffer) => stdout.push(data));
          stream.stderr.on('data', (data: Buffer) => stderr.push(data));
          stream.on('exit', (code: number | null) => {
            exitCode = code ?? 0;
          });
          stream.on('close', () => {
            clearTimeout(timer);
            client.end();
            resolve({ stdout: stdout.text(), stderr: stderr.text(), exitCode });
          });
        });
      })
      .on('error', (err) => {
        clearTimeout(timer);
        reject(guard.error(err));
      });
    connectSsh(client, server, connectConfig, 'exec', options);
  });
}

export const SSHBroker = { createSession, attach, close, closeForUser, exec, getSessionForUser };
