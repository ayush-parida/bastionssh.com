import type { FastifyRequest } from 'fastify';
import type { DeployServerState } from '@smt/shared';
import { auditAs, auditSystem } from '../audit/index.js';
import logger from '../logger.js';
import type { BastionctlBundle } from './bundle.js';
import { DeployError } from './errors.js';
import { installBundleFiles, installedVersion, integrity, isPinned, pinPath } from './install.js';
import type { Remote, ServerRow } from './remote.js';

/**
 * Keeping a server's bastionctl the one this BastionSSH ships (deployments
 * spec §2.3). Every use of a set-up server checks the installed program and
 * wrapper by SHA-256 first (deploy/install.ts). When they differ — a
 * BastionSSH update shipped a new bastionctl, or the files were changed —
 * BastionSSH installs its own bundled files over them, checks the hashes of
 * what landed, and the request goes on: the same file install Reinstall
 * does, never the rest of setup (network, proxy), and never a first setup
 * (a server without bastionctl stays "not set up").
 *
 * The content written is BastionSSH's own bundle, so any caller may trigger
 * it — a view-level read, a deploy, the background certificate check. It
 * needs only that the SSH user can write `<root>/bin` (as after setup; the
 * root is only ever one it can write). Files are written beside their
 * targets and renamed over them, so a bastionctl run already in progress is
 * unaffected; upgrades of one server are serialized in this process, and
 * each request re-checks under the lock, so concurrent requests upgrade
 * once. Each upgrade (and failed attempt) is audited as
 * `deploy.bastionctl_upgrade` with the versions it went from and to.
 *
 * `<root>/bin/.pinned` opts a server out: its bastionctl is never replaced
 * automatically, and a mismatch is refused (409 `bastionctl_mismatch`,
 * `pinned: true`) until someone removes the pin or clicks Reinstall. A failed
 * upgrade is refused the same way, and not tried again for
 * {@link UPGRADE_RETRY_MS} (Reinstall clears that).
 */

export interface BastionctlUpgrade {
  /** What the server had: `0.1.0+<build>`, `0.1.0` before build ids, null when unreadable. */
  from: string | null;
  to: string;
}

export interface InstalledBastionctl {
  integrity: DeployServerState['integrity'];
  /** The version the installed program says it is; null when missing or unreadable. */
  installedVersion: string | null;
  /** Mismatched and left alone because of `bin/.pinned` (only looked for on a mismatch). */
  pinned: boolean;
  /** Set when this call upgraded it. */
  upgraded?: BastionctlUpgrade;
  /** Why the upgrade failed (this call, or a recent one). */
  upgradeError?: string;
}

/** Records an upgrade attempt (deploy.bastionctl_upgrade): the request's user, or the system for background work. */
export type UpgradeAudit = (metadata: Record<string, unknown>) => void;

/** A request's user (with its address and user agent when there is one). */
export type UpgradeCaller = Pick<FastifyRequest, 'orgId' | 'user'> & Partial<Pick<FastifyRequest, 'ip' | 'headers'>>;

/** Audit upgrades under the user whose request triggered them, or the system when none did (`caller` null). */
export function upgradeAudit(caller: UpgradeCaller | null, server: ServerRow, trigger: 'request' | 'certificate_check'): UpgradeAudit {
  return (metadata) => {
    const meta = { ...metadata, trigger };
    if (!caller) return auditSystem(server.orgId, 'deploy.bastionctl_upgrade', 'server', server.id, server.name, meta);
    auditAs(
      { orgId: caller.orgId, userId: caller.user.id, email: caller.user.email, ip: caller.ip, userAgent: caller.headers?.['user-agent'] },
      'deploy.bastionctl_upgrade',
      'server',
      server.id,
      server.name,
      meta,
    );
  };
}

export const UPGRADE_RETRY_MS = 5 * 60_000;

/** Per server and root: the tail of the upgrade queue. */
const queues = new Map<string, Promise<unknown>>();
/** Per server, root and bundle: the last failure, so a server whose bin/ cannot be written is not retried on every request. */
const failures = new Map<string, { at: number; message: string }>();

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

const lockKey = (remote: Remote, root: string) => `${remote.server.id}\0${root}`;

/** Run `fn` in the server's upgrade queue (setup's file install, so it never interleaves with an upgrade). */
export function withUpgradeLock<T>(remote: Remote, root: string, fn: () => Promise<T>): Promise<T> {
  return serialized(lockKey(remote, root), fn);
}

/** Forget recent failures for a server (after a Reinstall). */
export function forgetUpgradeFailures(serverId: string): void {
  for (const key of failures.keys()) if (key.startsWith(`${serverId}\0`)) failures.delete(key);
}

export function resetBastionctlUpgradesForTests(): void {
  queues.clear();
  failures.clear();
}

/**
 * Check the installed bastionctl and, when it is not the shipped one and the
 * server is not pinned, upgrade it (see the module comment). Never throws for
 * a mismatch: the result says what is installed; {@link requireCurrent}
 * turns it into the refusal.
 */
export async function ensureCurrent(remote: Remote, root: string, bundle: BastionctlBundle, record: UpgradeAudit): Promise<InstalledBastionctl> {
  const first = await integrity(remote, root, bundle);
  if (first === 'ok') return { integrity: 'ok', installedVersion: bundle.version, pinned: false };
  if (first === 'missing') return { integrity: 'missing', installedVersion: null, pinned: false };
  return serialized(lockKey(remote, root), async (): Promise<InstalledBastionctl> => {
    // Another request may have upgraded it while this one waited
    const now = await integrity(remote, root, bundle);
    if (now !== 'mismatch') return { integrity: now, installedVersion: now === 'ok' ? bundle.version : null, pinned: false };
    const from = await installedVersion(remote, root);
    if (await isPinned(remote, root)) return { integrity: 'mismatch', installedVersion: from, pinned: true };
    const key = `${lockKey(remote, root)}\0${bundle.scriptSha256}`;
    const failed = failures.get(key);
    if (failed && Date.now() - failed.at < UPGRADE_RETRY_MS) return { integrity: 'mismatch', installedVersion: from, pinned: false, upgradeError: failed.message };
    const base = { root, from, to: bundle.version };
    try {
      await installBundleFiles(remote, root, bundle);
    } catch (err) {
      const message = (err as Error).message || 'the files could not be written';
      failures.set(key, { at: Date.now(), message });
      record({ ...base, result: 'failed', error: message.split('\n')[0]!.slice(0, 300) });
      logger.warn({ serverId: remote.server.id, root, from, to: bundle.version, err: message }, 'Could not upgrade bastionctl');
      return { integrity: 'mismatch', installedVersion: from, pinned: false, upgradeError: message };
    }
    failures.delete(key);
    record({ ...base, result: 'success' });
    logger.info({ serverId: remote.server.id, root, from, to: bundle.version }, 'Upgraded bastionctl');
    return { integrity: 'ok', installedVersion: bundle.version, pinned: false, upgraded: { from, to: bundle.version } };
  });
}

/** Throws the refusal for a bastionctl that is missing, or still not the shipped one. */
export function requireCurrent(state: InstalledBastionctl, root: string, bundle: BastionctlBundle): void {
  if (state.integrity === 'ok') return;
  if (state.integrity === 'missing') throw new DeployError('bastionctl is missing on this server; set it up again', 409, 'not_set_up');
  const versions = `installed ${state.installedVersion ?? 'unknown'}, this BastionSSH ships ${bundle.version}`;
  if (state.pinned) {
    throw new DeployError(
      `The bastionctl on this server is pinned (${pinPath(root)}) and is not the version this BastionSSH ships (${versions}). Remove the pin to let BastionSSH upgrade it, or Reinstall it with Set up.`,
      409,
      'bastionctl_mismatch',
      { pinned: true },
    );
  }
  throw new DeployError(
    `The bastionctl on this server is not the version this BastionSSH ships (${versions}), and upgrading it automatically failed: ${state.upgradeError ?? 'unknown error'}. Reinstall it with Set up.`,
    409,
    'bastionctl_mismatch',
  );
}
