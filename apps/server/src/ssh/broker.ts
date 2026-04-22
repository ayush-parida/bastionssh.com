import { Client } from 'ssh2';
import type { ClientChannel } from 'ssh2';
import { vault } from '../vault/index.js';
import type { WebSocket } from 'ws';
import type { FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import logger from '../logger.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SessionMeta {
  server: { host: string; port: number; username: string };
  key?: { id: string; encryptedPrivateKey: string };
  password?: string; // plaintext, decrypted by caller
  userId: string;
  cols: number;
  rows: number;
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
}

const sessions = new Map<string, ActiveSession>();

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
        logger.error({ err, sessionId: id }, 'SSH connection error');
        reject(err);
        sessions.delete(id);
      })
      .connect({
        host: meta.server.host,
        port: meta.server.port,
        username: meta.server.username,
        ...(privateKey ? { privateKey } : { password }),
      });
  });

  const session: ActiveSession = { meta, client, streamPromise, outputBuffer: [] };
  sessions.set(id, session);

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
      stream.once('close', () => {
        session.socket?.close();
        session.client.end();
        sessions.delete(id);
      });
    })
    .catch(() => {
      sessions.delete(id);
    });

  return id;
}

async function attach(sessionId: string, socket: WebSocket, _req: FastifyRequest) {
  const session = sessions.get(sessionId);
  if (!session) {
    socket.close(4404, 'Session not found');
    return;
  }

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
    const msg = err instanceof Error ? err.message : 'SSH connection failed';
    socket.close(4500, msg);
    sessions.delete(sessionId);
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
    if (session.socket === socket) session.socket = undefined;
  });
}

async function close(sessionId: string) {
  const session = sessions.get(sessionId);
  if (session) {
    session.client.end();
    session.socket?.close();
    sessions.delete(sessionId);
  }
}

/**
 * Execute a command on an existing session's SSH connection (separate channel).
 * The interactive shell stream is unaffected.
 */
async function exec(sessionId: string, command: string, timeoutMs = 30_000): Promise<ExecResult> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Session not found');

  return new Promise<ExecResult>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Command timed out')), timeoutMs);

    session.client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }

      let stdout = '';
      let stderr = '';
      let exitCode = 0;

      stream.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      stream.on('exit', (code: number | null) => {
        exitCode = code ?? 0;
      });
      stream.on('close', () => {
        clearTimeout(timer);
        resolve({ stdout: stdout.slice(0, 64_000), stderr: stderr.slice(0, 8_000), exitCode });
      });
    });
  });
}

/**
 * Open a one-shot SSH connection to run a command and return its output.
 * Used by the AI agent when there is no active interactive session.
 */
export async function execOnServer(
  server: { host: string; port: number; username: string },
  authOptions: { privateKey?: string; password?: string },
  command: string,
  timeoutMs = 30_000,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const client = new Client();
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

          let stdout = '';
          let stderr = '';
          let exitCode = 0;

          stream.on('data', (data: Buffer) => {
            stdout += data.toString();
          });
          stream.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
          });
          stream.on('exit', (code: number | null) => {
            exitCode = code ?? 0;
          });
          stream.on('close', () => {
            clearTimeout(timer);
            client.end();
            resolve({ stdout: stdout.slice(0, 64_000), stderr: stderr.slice(0, 8_000), exitCode });
          });
        });
      })
      .on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .connect({
        host: server.host,
        port: server.port,
        username: server.username,
        ...(authOptions.privateKey
          ? { privateKey: authOptions.privateKey }
          : { password: authOptions.password }),
      });
  });
}

export const SSHBroker = { createSession, attach, close, exec };
