import path from 'node:path';
import { deployReleaseId } from '@smt/shared';

/**
 * Names and the on-server layout (deployments spec §3). App names and release
 * ids are the only user-chosen parts of any path, container or image name, so
 * both are checked against one strict pattern before anything is built from
 * them.
 */

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const NETWORK = 'bastion-apps';
/**
 * Internal network the proxy reaches live releases on, by an alias per app
 * and port (see {@link liveAlias}). A release joins it only after its health
 * check, so a deploy moves traffic without reloading the proxy.
 */
export const LIVE_NETWORK = 'bastion-live';
export const PROXY_CONTAINER = 'bastion-caddy';
export const LABEL_APP = 'bastion.app';
export const LABEL_RELEASE = 'bastion.release';
export const LABEL_MANAGED = 'bastion.managed';

/** A failure with a message meant for the person running the command. */
export class BastionError extends Error {
  constructor(
    message: string,
    /** Process exit code: 1 failure, 2 usage, 3 invalid config, 4 busy (locked). */
    readonly exitCode = 1,
    /** More for `--json` to print beside `{ error, code }` (a failed proxy upgrade, for the audit). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BastionError';
  }
}

export function appName(value: unknown): string {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    throw new BastionError(`Invalid app name ${JSON.stringify(value)}: use a-z, 0-9 and -, starting with a letter or digit (at most 41)`, 2);
  }
  return value;
}

export function releaseId(value: unknown): string {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    throw new BastionError(`Invalid release id ${JSON.stringify(value)}`, 2);
  }
  return value;
}

export function envKey(value: unknown): string {
  if (typeof value !== 'string' || !ENV_KEY_PATTERN.test(value)) {
    throw new BastionError(`Invalid variable name ${JSON.stringify(value)}: letters, digits and _, not starting with a digit`, 2);
  }
  return value;
}

/**
 * Release id: UTC time to the second, then the first 8 hex digits of the
 * source checksum — sortable, and two uploads of the same source in the same
 * second collide (refused) rather than overwrite each other.
 */
export function newReleaseId(now: Date, checksum: string): string {
  return releaseId(deployReleaseId(now, checksum));
}

export const imageName = (app: string, release: string) => `bastion-${app}:${release}`;
export const containerName = (app: string, release: string) => `bastion-${app}-${release}`;
/**
 * The name the proxy sends an app's traffic to on {@link LIVE_NETWORK}: every
 * live container of the app answers to it. The port is part of it, so a
 * release listening on another port never shares it with the one serving. It
 * cannot equal a container name (those end in a release id) or another app's
 * alias (the app name is followed by `-live-` and digits only).
 */
export const liveAlias = (app: string, port: number) => `bastion-${app}-live-${port}`;
/**
 * Named Docker volume for `volumes: ["<name>:/path"]`. The `.` cannot occur
 * in an app or volume name, so no two apps share one: with `-`, app `a`'s
 * volume `b-data` and app `a-b`'s `data` were the same volume (and deleting
 * one app purged the other's data).
 */
export const volumeName = (app: string, name: string) => `bastion-${app}.${name}`;

/** Paths under the root directory (`/opt/bastion` or `$HOME/bastion`). */
export class Layout {
  constructor(readonly root: string) {}

  get bin() {
    return path.join(this.root, 'bin');
  }
  get apps() {
    return path.join(this.root, 'apps');
  }
  get tmp() {
    return path.join(this.root, 'tmp');
  }
  get proxy() {
    return path.join(this.root, 'proxy');
  }
  get caddyfile() {
    return path.join(this.proxy, 'Caddyfile');
  }
  /** Held while an image builds: one build per server at a time. */
  get buildLock() {
    return path.join(this.root, 'build.lock');
  }
  /** Held while setup runs: two setups at once would both create the networks and the proxy container. */
  get setupLock() {
    return path.join(this.root, 'setup.lock');
  }
  /** Held while the proxy config is rebuilt and switched: every app's switch in turn. */
  get proxyLock() {
    return path.join(this.root, 'proxy.lock');
  }
  app(app: string) {
    return path.join(this.apps, appName(app));
  }
  config(app: string) {
    return path.join(this.app(app), 'bastion.yml');
  }
  env(app: string) {
    return path.join(this.app(app), '.env');
  }
  releases(app: string) {
    return path.join(this.app(app), 'releases');
  }
  release(app: string, id: string) {
    return path.join(this.releases(app), releaseId(id));
  }
  current(app: string) {
    return path.join(this.app(app), 'current');
  }
  lock(app: string) {
    return path.join(this.app(app), 'deploy.lock');
  }
}

/** True when `child` is `parent` or inside it (both absolute, normalized). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel));
}
