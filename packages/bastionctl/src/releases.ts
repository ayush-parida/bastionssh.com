import fs from 'node:fs';
import path from 'node:path';
import type { DeployBuildType, DeployRelease } from '@smt/shared';
import { Layout, NAME_PATTERN } from './names.js';

/**
 * Releases on disk (deployments spec §3): `releases/<id>/` holds the source,
 * the build log and `release.json`; `current` is a relative symbolic link to
 * the release being served. Ids sort by time, newest last.
 */

export type ReleaseRecord = Omit<DeployRelease, 'current' | 'imagePresent'>;

const BUILD_TYPES: readonly DeployBuildType[] = ['nextjs', 'dockerfile', 'static', 'image'];

/** Release ids of an app, oldest first. */
export function releaseIds(layout: Layout, app: string): string[] {
  try {
    return fs
      .readdirSync(layout.releases(app), { withFileTypes: true })
      .filter((e) => e.isDirectory() && NAME_PATTERN.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function readRelease(layout: Layout, app: string, id: string): ReleaseRecord | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(layout.release(app, id), 'release.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
  const result = raw.result === 'success' || raw.result === 'failed' || raw.result === 'building' ? raw.result : 'failed';
  return {
    id,
    app,
    createdAt: str(raw.createdAt),
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
    actor: str(raw.actor, 'unknown'),
    checksum: str(raw.checksum),
    image: str(raw.image),
    container: str(raw.container),
    port: typeof raw.port === 'number' ? raw.port : 0,
    buildType: (BUILD_TYPES as readonly unknown[]).includes(raw.buildType) ? (raw.buildType as DeployBuildType) : 'dockerfile',
    result,
    error: typeof raw.error === 'string' ? raw.error : null,
    previous: typeof raw.previous === 'string' ? raw.previous : null,
    ...('digest' in raw && { digest: typeof raw.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(raw.digest) ? raw.digest : null }),
  };
}

export function writeRelease(layout: Layout, record: ReleaseRecord): void {
  const file = path.join(layout.release(record.app, record.id), 'release.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o644 });
  fs.renameSync(tmp, file);
}

/** The release `current` points at, or null. */
export function currentRelease(layout: Layout, app: string): string | null {
  return readReleaseLink(layout.current(app));
}

/** The release that was current before the last switch, or null. */
export function previousRelease(layout: Layout, app: string): string | null {
  return readReleaseLink(path.join(layout.app(app), 'previous'));
}

function readReleaseLink(link: string): string | null {
  try {
    const m = /^releases\/([^/]+)\/?$/.exec(fs.readlinkSync(link));
    return m && NAME_PATTERN.test(m[1]!) ? m[1]! : null;
  } catch {
    return null;
  }
}

function replaceLink(link: string, target: string) {
  const tmp = `${link}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, link);
}

/**
 * Point `current` at release `id`, atomically (a new link renamed over the
 * old); the release it pointed at becomes `previous`.
 */
export function setCurrent(layout: Layout, app: string, id: string): void {
  const old = currentRelease(layout, app);
  if (old && old !== id) replaceLink(path.join(layout.app(app), 'previous'), `releases/${old}`);
  replaceLink(layout.current(app), `releases/${id}`);
}

export function clearCurrent(layout: Layout, app: string): void {
  fs.rmSync(layout.current(app), { force: true });
  fs.rmSync(path.join(layout.app(app), 'previous'), { force: true });
}

/**
 * Releases to remove beyond `keep` (spec §5 step 8): the newest `keep` stay,
 * and so do the current and previous releases whatever their age.
 */
export function pruneCandidates(ids: readonly string[], keep: number, current: string | null, previous: string | null): string[] {
  const newestFirst = [...ids].sort().reverse();
  return newestFirst.slice(keep).filter((id) => id !== current && id !== previous);
}
