import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

/**
 * A running server keeps `<db>.lock` next to the database and touches it on a
 * heartbeat, so db:restore can tell it must not swap the file out from under
 * it. The pid alone is not enough in Docker: a `docker compose run` container
 * has its own pid namespace (the server was pid 1 there too), so a fresh
 * heartbeat counts as "running" wherever it was written.
 */

export const HEARTBEAT_MS = 30_000;
/** Two missed heartbeats and a little slack. */
export const LOCK_STALE_MS = 2 * HEARTBEAT_MS + 15_000;

export interface LockInfo {
  pid: number;
  hostname: string;
  port?: number;
  startedAt: string;
}

export function lockPath(dbPath: string): string {
  return `${dbPath}.lock`;
}

export function readLock(dbPath: string): { info: LockInfo | null; mtimeMs: number } | null {
  const file = lockPath(dbPath);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  let info: LockInfo | null = null;
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8')) as LockInfo;
  } catch {
    // Half-written or garbage: the heartbeat still decides
  }
  return { info, mtimeMs };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just is not ours to signal
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Why the database at `dbPath` looks in use by a server, or null when it does not. */
export function lockHeldReason(dbPath: string, now = Date.now()): string | null {
  const lock = readLock(dbPath);
  if (!lock) return null;
  const age = now - lock.mtimeMs;
  if (age < LOCK_STALE_MS) {
    const who = lock.info ? ` (pid ${lock.info.pid} on ${lock.info.hostname})` : '';
    return `a server${who} updated ${lockPath(dbPath)} ${Math.round(age / 1000)}s ago`;
  }
  const info = lock.info;
  if (info && info.hostname === os.hostname() && info.pid !== process.pid && pidAlive(info.pid)) {
    return `process ${info.pid} that holds ${lockPath(dbPath)} is still alive`;
  }
  return null;
}

/** Is something accepting connections on host:port? */
export function portInUse(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Take the lock for this process and keep it fresh until exit. Released on
 * a normal exit and on SIGINT/SIGTERM, after which the signal is re-raised so
 * the process still ends the way it would have without us.
 */
export function holdServerLock(dbPath: string, port?: number): () => void {
  const file = lockPath(dbPath);
  const info: LockInfo = { pid: process.pid, hostname: os.hostname(), port, startedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(info), { mode: 0o600 });

  const timer = setInterval(() => {
    const now = new Date();
    try {
      fs.utimesSync(file, now, now);
    } catch {
      // Deleted by hand: put it back
      try {
        fs.writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
      } catch {
        /* nothing more to do */
      }
    }
  }, HEARTBEAT_MS);
  timer.unref?.();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as LockInfo;
      // Never remove a lock another server wrote after us
      if (current.pid === info.pid && current.startedAt === info.startedAt) fs.rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  };
  const onSignal = (signal: NodeJS.Signals) => {
    release();
    process.kill(process.pid, signal);
  };
  process.once('exit', release);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return release;
}
