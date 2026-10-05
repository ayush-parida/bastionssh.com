import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import posix from 'node:path/posix';
import type { FastifyRequest } from 'fastify';
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import { LineSplitter } from '../docker/demux.js';
import { acquire as acquireSsh, poolKey as sshPoolKey, type DockerLease } from '../docker/pool.js';
import type { servers } from '../db/schema.js';
import { resolveServerAuth } from '../ssh/credentials.js';
import * as sftp from '../ssh/sftp.js';
import { DeployError } from './errors.js';

/**
 * The only way the deployments code reaches a server (deployments spec §7):
 * commands on an exec channel of the caller's pooled SSH connection — the
 * one Docker uses, opened through `sshConnectConfig` + `connectSsh`, so host
 * keys, jump hosts and agents apply and revoking the caller's access closes
 * it — and files through the caller's pooled SFTP channel. Everything above
 * this module works on {@link Remote}, which tests replace.
 */

export type ServerRow = typeof servers.$inferSelect;

export interface RunOptions {
  /** Complete output lines as they arrive. */
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
  /** Written to the command's stdin, which is then closed (always closed). */
  stdin?: string;
  timeoutMs?: number;
}

export interface RunResult {
  /** Null when the command was cut off (timeout, lost connection). */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  /** The last {@link MAX_STDERR} bytes. */
  stderr: string;
  durationMs: number;
}

export interface Remote {
  server: ServerRow;
  /** Run a POSIX shell command line (already quoted by the caller). */
  run(command: string, opts?: RunOptions): Promise<RunResult>;
  /** SHA-256 of a regular file, or null when there is none. */
  hashFile(path: string): Promise<string | null>;
  /** A regular file's contents (never through a link), or null when missing; refuses past `maxBytes`. */
  readFile(path: string, maxBytes: number): Promise<Buffer | null>;
  /** Replace a file atomically (written beside it, then renamed over it). */
  writeFile(path: string, data: Buffer | string, mode: number): Promise<void>;
  /** Stream an upload to a new file; refuses past `maxBytes`. Returns the size. */
  upload(path: string, source: Readable, maxBytes: number): Promise<number>;
  /** Remove a file; missing is fine. */
  remove(path: string): Promise<void>;
  /** Give the pooled connections back (exactly once). */
  release(): void;
}

const MAX_STDOUT = 8 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 2 * 60_000;

/** Run `command` on an exec channel of `ssh`. Rejects only when the channel cannot be opened. */
export function runOnClient(ssh: Client, command: string, opts: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    ssh.exec(command, (err: Error | undefined, channel: ClientChannel) => {
      if (err) return reject(new DeployError(`Could not run a command on the server: ${err.message}`, 502));
      const splitters = { stdout: new LineSplitter(), stderr: new LineSplitter() };
      const out: Buffer[] = [];
      let outBytes = 0;
      let errText = '';
      let exitCode: number | null = null;
      let signal: string | null = null;
      let timedOut = false;
      let done = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          channel.signal('TERM');
        } catch {
          // channel already gone
        }
        channel.close();
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref?.();
      // Nothing waits on a prompt: stdin gets what was given, then EOF
      channel.end(opts.stdin);

      const emit = (stream: 'stdout' | 'stderr', lines: string[]) => {
        for (const line of lines) opts.onLine?.(stream, line);
      };
      channel.on('data', (chunk: Buffer) => {
        if (outBytes < MAX_STDOUT) {
          out.push(chunk);
          outBytes += chunk.length;
        }
        emit('stdout', splitters.stdout.push(chunk));
      });
      channel.stderr.on('data', (chunk: Buffer) => {
        errText = (errText + chunk.toString('utf8')).slice(-MAX_STDERR);
        emit('stderr', splitters.stderr.push(chunk));
      });
      channel.on('exit', (code: number | null, sig?: string) => {
        exitCode = typeof code === 'number' ? code : null;
        signal = typeof sig === 'string' ? sig : null;
      });
      channel.on('error', () => {
        // surfaced through 'close' with no exit status
      });
      channel.on('close', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        emit('stdout', splitters.stdout.flush());
        emit('stderr', splitters.stderr.flush());
        resolve({
          exitCode: timedOut ? null : exitCode,
          signal,
          timedOut,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: errText,
          durationMs: Date.now() - started,
        });
      });
    });
  });
}

function renameOver(conn: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // posix-rename@openssh.com replaces the target; plain SFTP rename refuses to
    conn.ext_openssh_rename(from, to, (err) => {
      if (!err) return resolve();
      sftp
        .unlink(conn, to)
        .catch(() => {})
        .then(() => sftp.rename(conn, from, to))
        .then(resolve, reject);
    });
  });
}

function chmod(conn: SFTPWrapper, path: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => conn.chmod(path, mode, (err) => (err ? reject(err) : resolve())));
}

async function lstatFile(conn: SFTPWrapper, path: string): Promise<boolean> {
  try {
    return (await sftp.lstat(conn, path)).isFile();
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return false;
    throw err;
  }
}

/**
 * Open the caller's pooled SSH and SFTP connections to `server` (credentials
 * decrypted once). The caller must `release()`.
 */
export async function openRemote(req: Pick<FastifyRequest, 'orgId' | 'user'>, server: ServerRow): Promise<Remote> {
  const { auth } = await resolveServerAuth(req.orgId, server.id);
  const target = { id: server.id, host: server.host, port: server.port, username: server.username };
  const key = sshPoolKey(req.orgId, server.id, req.user.id);
  const ssh: DockerLease = await acquireSsh(key, target, auth, req.user.id);
  let files: sftp.SftpLease | null = null;
  const conn = async (): Promise<SFTPWrapper> => {
    files ??= await sftp.acquire(sftp.poolKey(req.orgId, server.id, req.user.id), target, auth, req.user.id);
    return files.sftp;
  };
  let released = false;

  return {
    server,
    run: (command, opts) => runOnClient(ssh.client, command, opts),
    async hashFile(path) {
      const c = await conn();
      if (!(await lstatFile(c, path))) return null;
      const hash = createHash('sha256');
      for await (const chunk of sftp.createReadStream(c, path) as AsyncIterable<Buffer>) hash.update(chunk);
      return hash.digest('hex');
    },
    async readFile(path, maxBytes) {
      const c = await conn();
      if (!(await lstatFile(c, path))) return null;
      return sftp.readFile(c, path, maxBytes);
    },
    async writeFile(path, data, mode) {
      const c = await conn();
      const tmp = posix.join(posix.dirname(path), `.${posix.basename(path)}.${randomBytes(6).toString('hex')}`);
      try {
        await new Promise<void>((resolve, reject) => {
          const stream = sftp.createWriteStream(c, tmp);
          stream.on('error', reject);
          stream.on('close', resolve);
          stream.end(data);
        });
        await chmod(c, tmp, mode);
        await renameOver(c, tmp, path);
      } catch (err) {
        await sftp.unlink(c, tmp).catch(() => {});
        throw new DeployError(`Could not write ${path} on the server: ${(err as Error).message}`, 502);
      }
    },
    async upload(path, source, maxBytes) {
      const c = await conn();
      let bytes = 0;
      source.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) source.destroy(new DeployError(`The upload is larger than ${Math.round(maxBytes / 1024 ** 2)} MiB`, 413));
      });
      try {
        await pipeline(source, sftp.createWriteStream(c, path));
      } catch (err) {
        await sftp.unlink(c, path).catch(() => {});
        if (err instanceof DeployError) throw err;
        throw new DeployError(`The upload to the server failed: ${(err as Error).message}`, 502);
      }
      return bytes;
    },
    async remove(path) {
      const c = await conn();
      await sftp.unlink(c, path).catch(() => {});
    },
    release() {
      if (released) return;
      released = true;
      ssh.release();
      (files as sftp.SftpLease | null)?.release();
    },
  };
}
