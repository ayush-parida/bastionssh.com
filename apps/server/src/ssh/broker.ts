import { Client } from 'ssh2';
import type { ClientChannel } from 'ssh2';
import { vault } from '../vault/index.js';
import type { WebSocket } from 'ws';
import type { FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import logger from '../logger.js';

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
  socket.on('message', (msg) => {
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

export const SSHBroker = { createSession, attach, close };
