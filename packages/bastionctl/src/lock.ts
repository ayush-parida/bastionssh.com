import fs from 'node:fs';
import os from 'node:os';
import type { DeployLock } from '@smt/shared';
import { BastionError } from './names.js';
import type { DockerApi } from './docker.js';

/**
 * Exclusive locks as files created with O_EXCL (deployments spec §5 step 1):
 * `apps/<app>/deploy.lock` per app, `build.lock` for the one build a server
 * runs at a time. A lock is stale — and taken over — when it is older than
 * {@link STALE_AFTER_MS}, or when whoever holds it is gone: every bastionctl
 * run is its own container, so the holder is recorded as the container's
 * hostname (its short id) and pid, and checked with the Docker API (or, for
 * a run on this same host, the pid).
 */

export const STALE_AFTER_MS = 30 * 60 * 1000;

export interface LockInfo {
  holder: string;
  host: string;
  pid: number;
  since: string;
}

export interface LockOptions {
  holder: string;
  docker?: DockerApi;
  now?: () => Date;
  /** What is locked, for the error message ("deploy of site1"). */
  what: string;
}

export function readLock(file: string): LockInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockInfo>;
    if (typeof info.since !== 'string') return null;
    return {
      holder: typeof info.holder === 'string' ? info.holder : 'unknown',
      host: typeof info.host === 'string' ? info.host : '',
      pid: typeof info.pid === 'number' ? info.pid : 0,
      since: info.since,
    };
  } catch {
    return null;
  }
}

export function lockView(info: LockInfo | null): DeployLock | null {
  return info ? { holder: info.holder, since: info.since } : null;
}

function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Is the holder of `info` gone? Unknown counts as alive (only age frees the lock then). */
async function holderGone(info: LockInfo, docker?: DockerApi): Promise<boolean> {
  if (info.host === os.hostname()) return !pidAlive(info.pid);
  if (!docker || !/^[a-f0-9]{12,64}$/.test(info.host)) return false;
  try {
    const container = await docker.inspectContainer(info.host);
    return !container || !container.State.Running;
  } catch {
    return false;
  }
}

export async function isStale(info: LockInfo | null, opts: Pick<LockOptions, 'docker' | 'now'>): Promise<boolean> {
  // Unreadable (half-written by a run that died at that instant): stale
  if (!info) return true;
  const age = (opts.now?.() ?? new Date()).getTime() - Date.parse(info.since);
  if (!(age < STALE_AFTER_MS)) return true;
  return holderGone(info, opts.docker);
}

/**
 * Take the lock or throw (exit code 4) naming who holds it. Returns the
 * release, which removes the file only while it is still ours.
 */
export async function acquireLock(file: string, opts: LockOptions): Promise<() => void> {
  const info: LockInfo = { holder: opts.holder, host: os.hostname(), pid: process.pid, since: (opts.now?.() ?? new Date()).toISOString() };
  const body = JSON.stringify(info) + '\n';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx', mode: 0o644 });
      return () => {
        try {
          if (fs.readFileSync(file, 'utf8') === body) fs.unlinkSync(file);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const held = readLock(file);
    if (attempt === 0 && (await isStale(held, opts))) {
      try {
        fs.unlinkSync(file);
      } catch {
        // someone else cleared it first; the retry decides
      }
      continue;
    }
    throw new BastionError(`The ${opts.what} is locked by ${held?.holder ?? 'another run'} since ${held?.since ?? 'just now'}; try again when it finishes`, 4);
  }
  throw new BastionError(`Could not lock the ${opts.what}`, 4);
}
