import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { DEPLOY_MAX_BUILD_ARGS, serviceTemplate, type DeployAppConfig, type DeployBackupSettings, type DeployBuildType, type DeployHealthcheckType, type DeployValidation, type DeployValidationIssue, type DeployVolume } from '@smt/shared';
import { NODE_BUILD_VERSIONS } from './images.js';
import { BastionError, ENV_KEY_PATTERN, Layout, NAME_PATTERN } from './names.js';
import { NGINX_TLS, NGINX_UPSTREAM_PORT, proxyMode } from './nginx.js';

/**
 * `bastion.yml` (deployments spec §4), strictly validated: unknown keys are
 * refused at every level, domains are checked for syntax and for being
 * claimed by another app on the server, and every path the config names
 * (`build.dir`, `build.output`, `run.env_file`, certificate files) must stay
 * inside the upload or the app folder. Volumes are named Docker volumes only,
 * never host paths.
 */

/** Larger configs are refused before parsing. */
export const MAX_CONFIG_BYTES = 64 * 1024;

const BUILD_TYPES: readonly DeployBuildType[] = ['nextjs', 'dockerfile', 'static', 'image'];
const HEALTH_TYPES: readonly DeployHealthcheckType[] = ['http', 'tcp', 'command'];
/**
 * A registry reference: `[registry[:port]/]repo[/more][:tag][@sha256:<64 hex>]`,
 * lower-case repository path, with a tag or a digest (never an implied latest).
 */
const IMAGE_REF =
  /^(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*(?::\d{1,5})?)\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
/** `scope:hostPort`, or `scope:hostPort:containerPort` (another port of the container than run.port). */
const PUBLISH = /^(localhost|public):(\d{1,5})(?::(\d{1,5}))?$/;
/** Host ports the proxy owns: never published by an app. */
const RESERVED_PORTS = [80, 443, NGINX_UPSTREAM_PORT];
const MAX_COMMAND_ARGS = 64;
const BACKUP_SCHEDULES = ['off', 'hourly', 'daily'] as const;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_PROVIDER = /^dns:[a-z0-9_]{1,40}$/;
const VOLUME = /^([a-z0-9][a-z0-9_-]{0,40}):(\/[^:\0]*)(:ro)?$/;
const MEMORY = /^([1-9]\d{0,5})([kmg]?)$/;
const DURATION = /^(\d{1,6})(ms|s|m)$/;
const NODE_VERSION = /^\d{2}(?:\.\d{1,3}){0,2}$/;

export const DEFAULTS = {
  redirect_www: 'none',
  tls: 'auto',
  port: 3000,
  env_file: '.env',
  healthPath: '/',
  healthTimeout: '30s',
  keep_releases: 5,
  proxy: 'caddy',
  deployPermission: 'operate',
  strategy: 'rolling',
  backupKeep: 7,
} as const;

const KEYS = {
  root: ['name', 'service', 'domains', 'redirect_www', 'tls', 'build', 'run', 'healthcheck', 'keep_releases', 'proxy', 'permissions', 'backups'],
  build: ['type', 'node', 'dir', 'output', 'image', 'where', 'args'],
  run: ['port', 'env_file', 'volumes', 'memory', 'cpus', 'strategy', 'publish', 'command', 'entrypoint'],
  volume: ['name', 'path', 'readonly', 'exclusive'],
  healthcheck: ['type', 'path', 'command', 'timeout'],
  tls: ['cert', 'key'],
  permissions: ['deploy'],
  backups: ['schedule', 'keep'],
};

/** A domain Caddy can serve: lower-case labels, at least two, `*.` only as the first label. */
export function isDomain(value: string): boolean {
  if (value.length > 253) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  return labels.every((label, i) => (i === 0 && label === '*') || LABEL.test(label)) && !/^\d+$/.test(labels[labels.length - 1]!);
}

/**
 * A name people put www. in front of: example.com, or example.co.uk under a short
 * second-level suffix of a country code. Not api.example.com.
 */
function isRegistrable(domain: string): boolean {
  const labels = domain.split('.');
  if (labels.length === 2) return true;
  return labels.length === 3 && labels[2]!.length === 2 && labels[1]!.length <= 3;
}

/**
 * `domains` with the other half of each www pair added after its partner, so that
 * `redirect_www` works without listing both names: www.example.com brings
 * example.com, and a registrable example.com brings www.example.com.
 */
export function withWwwCounterparts(domains: readonly string[], mode: DeployAppConfig['redirect_www']): string[] {
  if (mode === 'none') return [...domains];
  const out: string[] = [];
  const seen = new Set(domains);
  for (const d of domains) {
    out.push(d);
    if (d.startsWith('*.')) continue;
    const other = d.startsWith('www.') ? d.slice(4) : isRegistrable(d) ? `www.${d}` : null;
    if (other && isDomain(other) && !seen.has(other)) {
      seen.add(other);
      out.push(other);
    }
  }
  return out;
}

/**
 * A relative path that stays where it is resolved from: no absolute paths, no
 * `..` segments, no backslashes or control characters. `.` is allowed.
 */
export function isSafeRelative(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f\\]/.test(value) || value.startsWith('/')) return false;
  return value.split('/').every((seg) => seg !== '..');
}

/** `512m` → bytes. */
export function memoryBytes(value: string): number {
  const m = MEMORY.exec(value);
  if (!m) throw new BastionError(`Invalid memory ${value}`);
  const unit = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2] as '' | 'k' | 'm' | 'g'];
  return Number(m[1]) * unit;
}

/** Whether an image reference names a digest (`…@sha256:…`): the same bytes on every pull. */
export function isDigestPinned(ref: string): boolean {
  return /@sha256:[a-f0-9]{64}$/.test(ref);
}

export function isImageRef(value: string): boolean {
  if (value.length > 512 || !IMAGE_REF.test(value)) return false;
  // A tag or a digest: the last path segment has a `:` (a registry port is before a `/`) or there is an `@`
  return value.includes('@') || value.slice(value.lastIndexOf('/') + 1).includes(':');
}

/** `30s` → milliseconds. */
export function durationMs(value: string): number {
  const m = DURATION.exec(value);
  if (!m) throw new BastionError(`Invalid duration ${value}`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000 }[m[2] as 'ms' | 's' | 'm'];
}

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

class Issues {
  readonly list: DeployValidationIssue[] = [];
  add(path: string, message: string) {
    this.list.push({ path, message });
  }
  unknownKeys(value: Raw, allowed: readonly string[], prefix: string) {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.add(prefix ? `${prefix}.${key}` : key, 'Unknown key');
    }
  }
}

/** Parse YAML text into plain data; syntax problems, duplicate keys and aliases are issues. */
export function parseYaml(text: string): { value: unknown; issues: DeployValidationIssue[] } {
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) {
    return { value: null, issues: [{ path: '', message: `Config is larger than ${MAX_CONFIG_BYTES / 1024} KiB` }] };
  }
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false, strict: true, schema: 'core' });
  const errors = [...doc.errors, ...doc.warnings];
  if (errors.length > 0) {
    return { value: null, issues: errors.map((e) => ({ path: '', message: e.message.split('\n')[0]! })) };
  }
  try {
    // Aliases buy nothing in a config this size and open the door to expansion bombs
    return { value: doc.toJS({ maxAliasCount: 0 }), issues: [] };
  } catch (err) {
    return { value: null, issues: [{ path: '', message: (err as Error).message }] };
  }
}

/** One entry of `run.volumes`: `name:/path[:ro]`, or `{ name, path, readonly?, exclusive? }`. */
function parseVolume(v: unknown, at: string, issues: Issues): DeployVolume | null {
  let volume: DeployVolume;
  if (typeof v === 'string') {
    const m = VOLUME.exec(v);
    if (!m) {
      issues.add(at, 'Use <name>:/absolute/path[:ro] or { name, path, exclusive } — named volumes only, never host paths');
      return null;
    }
    volume = { name: m[1]!, path: m[2]!, readonly: m[3] === ':ro', exclusive: false };
  } else if (isObject(v)) {
    issues.unknownKeys(v, KEYS.volume, at);
    const { name, path: target, readonly, exclusive } = v;
    let ok = true;
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(name)) {
      issues.add(`${at}.name`, 'Required: a-z, 0-9, _ and -, starting with a letter or digit');
      ok = false;
    }
    if (typeof target !== 'string' || !target.startsWith('/') || target.length > 255 || /[:\0]/.test(target)) {
      issues.add(`${at}.path`, 'Required: an absolute path in the container');
      ok = false;
    }
    for (const [key, flag] of [['readonly', readonly], ['exclusive', exclusive]] as const) {
      if (flag !== undefined && typeof flag !== 'boolean') {
        issues.add(`${at}.${key}`, 'true or false');
        ok = false;
      }
    }
    if (!ok) return null;
    volume = { name: name as string, path: target as string, readonly: readonly === true, exclusive: exclusive === true };
  } else {
    issues.add(at, 'Use <name>:/absolute/path[:ro] or { name, path, exclusive }');
    return null;
  }
  if (volume.path === '/' || volume.path.split('/').some((seg) => seg === '..' || seg === '.')) {
    issues.add(at, 'The container path must be absolute, not /, and without . or ..');
    return null;
  }
  return volume;
}

/**
 * Validate parsed `bastion.yml` data for app `app` (null: any valid name).
 * Returns the normalized config, or the issues found — all of them, not just
 * the first, so an editor can show every problem at once.
 */
export function validateConfig(data: unknown, app: string | null): { config: DeployAppConfig | null; issues: DeployValidationIssue[] } {
  const issues = new Issues();
  if (!isObject(data)) {
    issues.add('', 'The config must be a mapping (key: value)');
    return { config: null, issues: issues.list };
  }
  issues.unknownKeys(data, KEYS.root, '');

  // name
  const name = data.name;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    issues.add('name', 'Required: a-z, 0-9 and -, starting with a letter or digit (at most 41)');
  } else if (app !== null && name !== app) {
    issues.add('name', `Must be the app's name (${app})`);
  }

  // service: the quick-service template id (informational)
  let service: string | null = null;
  if (data.service !== undefined && data.service !== null) {
    if (typeof data.service !== 'string' || !NAME_PATTERN.test(data.service)) issues.add('service', 'A template id: a-z, 0-9 and - (like postgres)');
    else service = data.service;
  }

  // tls (read first: wildcard domains depend on it)
  let tls: DeployAppConfig['tls'] = DEFAULTS.tls;
  if (data.tls !== undefined) {
    if (typeof data.tls === 'string') {
      if (['auto', 'staging', 'internal'].includes(data.tls) || DNS_PROVIDER.test(data.tls)) tls = data.tls;
      else issues.add('tls', 'Must be auto, staging, internal, dns:<provider>, or { cert, key }');
    } else if (isObject(data.tls)) {
      issues.unknownKeys(data.tls, KEYS.tls, 'tls');
      const { cert, key } = data.tls;
      for (const [k, v] of [['cert', cert], ['key', key]] as const) {
        if (typeof v !== 'string' || !isSafeRelative(v)) issues.add(`tls.${k}`, 'Required: a file path inside the app folder');
      }
      if (typeof cert === 'string' && typeof key === 'string') tls = { cert, key };
    } else {
      issues.add('tls', 'Must be auto, staging, internal, dns:<provider>, or { cert, key }');
    }
  }
  const wildcardOk = typeof tls !== 'string' || tls === 'internal' || tls.startsWith('dns:');

  // domains
  const domains: string[] = [];
  if (!Array.isArray(data.domains)) {
    // [] is a service reached only by other apps on bastion-apps (a database, a cache): no proxy entry
    issues.add('domains', 'Required: a list of domains, like [example.com], or [] for a service only other apps reach');
  } else if (data.domains.length > 50) {
    issues.add('domains', 'At most 50 domains');
  } else {
    data.domains.forEach((d, i) => {
      if (typeof d !== 'string' || !isDomain(d)) return issues.add(`domains.${i}`, `Not a valid domain: ${JSON.stringify(d)} (lower case, like example.com)`);
      if (d.startsWith('*.') && !wildcardOk) return issues.add(`domains.${i}`, 'Wildcard domains need tls: dns:<provider>, internal, or certificate files');
      if (domains.includes(d)) return issues.add(`domains.${i}`, `Listed twice: ${d}`);
      domains.push(d);
    });
  }

  let redirect: DeployAppConfig['redirect_www'] = DEFAULTS.redirect_www;
  if (data.redirect_www !== undefined) {
    if (data.redirect_www === 'apex' || data.redirect_www === 'www' || data.redirect_www === 'none') redirect = data.redirect_www;
    else issues.add('redirect_www', 'Must be apex, www or none');
  }

  // build
  let build: DeployAppConfig['build'] = { type: 'dockerfile', node: null, dir: '.', output: null, image: null, where: 'server', args: [] };
  if (!isObject(data.build)) {
    issues.add('build', 'Required: { type: nextjs | dockerfile | static | image }');
  } else {
    issues.unknownKeys(data.build, KEYS.build, 'build');
    const { type, node, dir, output, image, where, args } = data.build;
    if (typeof type !== 'string' || !(BUILD_TYPES as readonly string[]).includes(type)) {
      issues.add('build.type', 'Must be nextjs, dockerfile, static or image');
    }
    const known = (BUILD_TYPES as readonly unknown[]).includes(type);
    const buildType = known ? (type as DeployBuildType) : 'dockerfile';
    let imageRef: string | null = null;
    if (buildType === 'image') {
      if (image === undefined) issues.add('build.image', 'Required with type image: a registry reference like postgres:16.4@sha256:… (a digest is strongly recommended)');
      else if (typeof image !== 'string' || !isImageRef(image)) {
        issues.add('build.image', 'A registry reference with a tag or digest, like postgres:16.4 or postgres@sha256:<64 hex digits>');
      } else imageRef = image;
      for (const key of ['node', 'dir', 'output', 'where', 'args'] as const) {
        if (data.build[key] !== undefined) issues.add(`build.${key}`, 'Not used with type image: nothing is built');
      }
    } else if (image !== undefined && known) {
      issues.add('build.image', 'Only with type image');
    }
    let nodeVersion: string | null = null;
    if (node !== undefined && buildType !== 'image') {
      const v = typeof node === 'number' ? String(node) : node;
      if (known && buildType === 'dockerfile') issues.add('build.node', 'Only for nextjs and static builds (a Dockerfile picks its own base image)');
      else if (typeof v !== 'string' || !NODE_VERSION.test(v)) issues.add('build.node', 'A Node.js version like "20" or "22.11"');
      else if (!NODE_BUILD_VERSIONS.includes(v.split('.')[0]!)) issues.add('build.node', `Builds use Node.js ${NODE_BUILD_VERSIONS.join(', ')}`);
      else nodeVersion = v;
    }
    let buildDir = '.';
    if (dir !== undefined && buildType !== 'image') {
      if (typeof dir !== 'string' || !isSafeRelative(dir)) issues.add('build.dir', 'A relative path inside the upload, without ..');
      else buildDir = dir;
    }
    let buildOutput: string | null = buildType === 'static' ? 'out' : null;
    if (output !== undefined && buildType !== 'image') {
      if (known && buildType !== 'static') issues.add('build.output', 'Only for static builds');
      else if (typeof output !== 'string' || !isSafeRelative(output)) issues.add('build.output', 'A relative path inside build.dir, without ..');
      else buildOutput = output;
    }
    // Where the image is built: on the server (default) or by BastionSSH's builder, which ships only the image
    let buildWhere: 'server' | 'bastion' = 'server';
    if (where !== undefined && buildType !== 'image') {
      if (where !== 'server' && where !== 'bastion') issues.add('build.where', 'Must be server or bastion');
      else buildWhere = where;
    }
    // .env names a build gets besides NEXT_PUBLIC_* (values read for the build only, never kept)
    const buildArgs: string[] = [];
    if (args !== undefined && buildType !== 'image') {
      if (!Array.isArray(args) || args.length > DEPLOY_MAX_BUILD_ARGS) {
        issues.add('build.args', `A list of up to ${DEPLOY_MAX_BUILD_ARGS} .env variable names, like [VITE_API_URL]`);
      } else {
        args.forEach((a, i) => {
          if (typeof a !== 'string' || !ENV_KEY_PATTERN.test(a)) return issues.add(`build.args.${i}`, 'A variable name: letters, digits and _, not starting with a digit');
          if (buildArgs.includes(a)) return issues.add(`build.args.${i}`, `Listed twice: ${a}`);
          buildArgs.push(a);
        });
      }
    }
    build = { type: buildType, node: nodeVersion, dir: buildDir, output: buildOutput, image: imageRef, where: buildWhere, args: buildArgs };
  }

  // run
  const run: DeployAppConfig['run'] = {
    port: DEFAULTS.port,
    env_file: DEFAULTS.env_file,
    volumes: [],
    memory: null,
    cpus: null,
    strategy: DEFAULTS.strategy,
    publish: { scope: 'none', port: null, target: null },
    command: null,
    entrypoint: null,
  };
  let strategyAsked: unknown;
  if (data.run !== undefined) {
    if (!isObject(data.run)) {
      issues.add('run', 'Must be a mapping');
    } else {
      issues.unknownKeys(data.run, KEYS.run, 'run');
      const { port, env_file, volumes, memory, cpus, strategy, publish, command, entrypoint } = data.run;
      if (port !== undefined) {
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) issues.add('run.port', 'A port from 1 to 65535');
        else run.port = port;
      }
      if (env_file !== undefined) {
        if (typeof env_file !== 'string' || !isSafeRelative(env_file) || env_file === '.') issues.add('run.env_file', 'A file inside the app folder, without ..');
        else run.env_file = env_file;
      }
      if (volumes !== undefined) {
        if (!Array.isArray(volumes)) {
          issues.add('run.volumes', 'A list like ["uploads:/app/uploads"] or [{ name: data, path: /data, exclusive: true }]');
        } else {
          const names = new Set<string>();
          volumes.forEach((v, i) => {
            const volume = parseVolume(v, `run.volumes.${i}`, issues);
            if (!volume) return;
            if (names.has(volume.name)) return issues.add(`run.volumes.${i}`, `Volume ${volume.name} is listed twice`);
            names.add(volume.name);
            run.volumes.push(volume);
          });
        }
      }
      if (memory !== undefined) {
        const v = typeof memory === 'number' ? String(memory) : memory;
        if (typeof v !== 'string' || !MEMORY.test(v)) issues.add('run.memory', 'Like 512m or 1g');
        else if (memoryBytes(v) < 6 * 1024 ** 2) issues.add('run.memory', 'At least 6m (Docker’s minimum)');
        else run.memory = v;
      }
      if (cpus !== undefined) {
        if (typeof cpus !== 'number' || !(cpus >= 0.01 && cpus <= 256)) issues.add('run.cpus', 'A number of CPUs from 0.01 to 256');
        else run.cpus = cpus;
      }
      if (strategy !== undefined) {
        if (strategy !== 'rolling' && strategy !== 'recreate') issues.add('run.strategy', 'Must be rolling or recreate');
        else strategyAsked = strategy;
      }
      if (publish !== undefined) {
        const m = typeof publish === 'string' ? PUBLISH.exec(publish) : null;
        if (publish === 'none') {
          // the default
        } else if (!m) {
          issues.add('run.publish', 'Must be none, localhost:<port> or public:<port> (or <scope>:<host port>:<container port>)');
        } else {
          const hostPort = Number(m[2]);
          const target = m[3] === undefined ? null : Number(m[3]);
          if (hostPort < 1 || hostPort > 65535) issues.add('run.publish', 'A host port from 1 to 65535');
          else if (target !== null && (target < 1 || target > 65535)) issues.add('run.publish', 'A container port from 1 to 65535');
          else if (RESERVED_PORTS.includes(hostPort)) issues.add('run.publish', `Port ${hostPort} belongs to the proxy; pick another host port`);
          else run.publish = { scope: m[1] as 'localhost' | 'public', port: hostPort, target };
        }
      }
      // The image's CMD and ENTRYPOINT, replaced (a quick service's server flags); argv as given, no shell unless named
      for (const [key, value] of [['command', command], ['entrypoint', entrypoint]] as const) {
        if (value === undefined || value === null) continue;
        if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMMAND_ARGS || !value.every((a) => typeof a === 'string' && a.length <= 4096 && !a.includes('\0'))) {
          issues.add(`run.${key}`, `A list of 1 to ${MAX_COMMAND_ARGS} arguments, like ["server", "/data"]`);
        } else run[key] = value as string[];
      }
    }
  }
  // Two containers cannot share an exclusive volume or a host port: the old one stops first
  const exclusive = run.volumes.find((v) => v.exclusive);
  const forced = exclusive ? `volume ${exclusive.name} is exclusive` : run.publish.scope !== 'none' ? 'run.publish binds a host port' : null;
  if (forced && strategyAsked === 'rolling') issues.add('run.strategy', `Must be recreate: ${forced} (two containers cannot use it at once)`);
  run.strategy = forced ? 'recreate' : ((strategyAsked as DeployAppConfig['run']['strategy'] | undefined) ?? DEFAULTS.strategy);
  if (build.type === 'static') run.port = 80;

  // healthcheck: HTTP for apps with domains, a TCP connect for services without (unless the config says)
  const healthcheck: DeployAppConfig['healthcheck'] = {
    type: domains.length > 0 ? 'http' : 'tcp',
    path: DEFAULTS.healthPath as string,
    command: null,
    timeout: DEFAULTS.healthTimeout as string,
  };
  if (data.healthcheck !== undefined) {
    if (!isObject(data.healthcheck)) {
      issues.add('healthcheck', 'Must be a mapping');
    } else {
      issues.unknownKeys(data.healthcheck, KEYS.healthcheck, 'healthcheck');
      const { type, path: hPath, command, timeout } = data.healthcheck;
      if (type !== undefined) {
        if (typeof type !== 'string' || !(HEALTH_TYPES as readonly string[]).includes(type)) issues.add('healthcheck.type', 'Must be http, tcp or command');
        else healthcheck.type = type as DeployHealthcheckType;
      } else if (hPath !== undefined) {
        healthcheck.type = 'http';
      } else if (command !== undefined) {
        healthcheck.type = 'command';
      }
      if (hPath !== undefined) {
        // eslint-disable-next-line no-control-regex
        if (typeof hPath !== 'string' || !hPath.startsWith('/') || hPath.length > 200 || /[\s\0-\x1f'"`\\]/.test(hPath)) {
          issues.add('healthcheck.path', 'A URL path starting with /, without spaces or quotes');
        } else if (healthcheck.type !== 'http') {
          issues.add('healthcheck.path', 'Only with type http');
        } else healthcheck.path = hPath;
      }
      if (command !== undefined) {
        if (healthcheck.type !== 'command') issues.add('healthcheck.command', 'Only with type command');
        else if (
          !Array.isArray(command) ||
          command.length === 0 ||
          command.length > MAX_COMMAND_ARGS ||
          !command.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 1024 && !/[\0\n\r]/.test(a))
        ) {
          issues.add('healthcheck.command', `A list of 1 to ${MAX_COMMAND_ARGS} arguments, like ["pg_isready", "-U", "app"] (run inside the container, no shell)`);
        } else healthcheck.command = command as string[];
      } else if (healthcheck.type === 'command') {
        issues.add('healthcheck.command', 'Required with type command: a list like ["pg_isready", "-U", "app"]');
      }
      if (timeout !== undefined) {
        if (typeof timeout !== 'string' || !DURATION.test(timeout)) issues.add('healthcheck.timeout', 'Like 30s or 2m');
        else if (durationMs(timeout) < 1000 || durationMs(timeout) > 600_000) issues.add('healthcheck.timeout', 'From 1s to 10m');
        else healthcheck.timeout = timeout;
      }
    }
  }

  let keep: number = DEFAULTS.keep_releases;
  if (data.keep_releases !== undefined) {
    const k = data.keep_releases;
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 2 || k > 50) issues.add('keep_releases', 'A whole number from 2 to 50');
    else keep = k;
  }

  let proxy: DeployAppConfig['proxy'] = DEFAULTS.proxy;
  if (data.proxy !== undefined) {
    if (data.proxy === 'caddy' || data.proxy === 'nginx') proxy = data.proxy;
    else issues.add('proxy', 'Must be caddy or nginx');
  }
  // Who may deploy and roll back on BastionSSH: members who operate the server (default) or only those who manage it
  const permissions: DeployAppConfig['permissions'] = { deploy: DEFAULTS.deployPermission };
  if (data.permissions !== undefined) {
    if (!isObject(data.permissions)) {
      issues.add('permissions', 'Must be a mapping like { deploy: manage }');
    } else {
      issues.unknownKeys(data.permissions, KEYS.permissions, 'permissions');
      const { deploy } = data.permissions;
      if (deploy !== undefined) {
        if (deploy === 'operate' || deploy === 'manage') permissions.deploy = deploy;
        else issues.add('permissions.deploy', 'Must be operate or manage');
      }
    }
  }

  // A quick service's backups (services spec §3.4): what bastion-cron runs, and how many are kept
  const backups: DeployBackupSettings = { schedule: 'off', keep: DEFAULTS.backupKeep };
  if (data.backups !== undefined) {
    if (!isObject(data.backups)) {
      issues.add('backups', 'Must be a mapping like { schedule: daily, keep: 7 }');
    } else {
      issues.unknownKeys(data.backups, KEYS.backups, 'backups');
      const { schedule, keep: kept } = data.backups;
      if (schedule !== undefined) {
        if (typeof schedule !== 'string' || !(BACKUP_SCHEDULES as readonly string[]).includes(schedule)) issues.add('backups.schedule', 'Must be off, hourly or daily');
        else backups.schedule = schedule as DeployBackupSettings['schedule'];
      }
      if (kept !== undefined) {
        if (typeof kept !== 'number' || !Number.isInteger(kept) || kept < 1 || kept > 100) issues.add('backups.keep', 'A whole number from 1 to 100');
        else backups.keep = kept;
      }
      if (backups.schedule !== 'off' && !serviceTemplate(service)?.backup) {
        issues.add('backups.schedule', service ? `The ${service} template has no backup command` : 'Backups are for quick services (service: postgres, mysql, mariadb, mongodb, redis, valkey)');
      }
    }
  }

  // certbot's webroot challenge on the host: no wildcards, no DNS providers, no internal CA
  if (proxy === 'nginx' && (typeof tls !== 'string' || !(NGINX_TLS as readonly string[]).includes(tls))) {
    issues.add('tls', 'With proxy: nginx, tls must be auto or staging (certificates come from certbot on the host)');
  }

  if (issues.list.length > 0) return { config: null, issues: issues.list };
  return {
    config: {
      name: name as string,
      service,
      domains: withWwwCounterparts(domains, redirect),
      redirect_www: redirect,
      tls,
      build,
      run,
      healthcheck,
      keep_releases: keep,
      proxy,
      permissions,
      backups,
    },
    issues: [],
  };
}

/** Parse and validate config text. */
export function checkConfigText(text: string, app: string | null): { config: DeployAppConfig | null; issues: DeployValidationIssue[] } {
  const parsed = parseYaml(text);
  if (parsed.issues.length > 0) return { config: null, issues: parsed.issues };
  return validateConfig(parsed.value, app);
}

/** The apps on the server: folders under apps/ with a valid name. */
export function appNames(layout: Layout): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(layout.apps, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && NAME_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** Read and validate an app's bastion.yml; throws with every issue listed. */
export function loadConfig(layout: Layout, app: string): DeployAppConfig {
  let text: string;
  try {
    text = fs.readFileSync(layout.config(app), 'utf8');
  } catch {
    throw new BastionError(`App ${app} has no bastion.yml (run bastionctl init ${app})`);
  }
  const { config, issues } = checkConfigText(text, app);
  if (!config) throw new BastionError(`bastion.yml of ${app} is invalid: ${formatIssues(issues)}`, 3);
  return config;
}

/** Load an app's config, or null with the reason (for listings). */
export function tryLoadConfig(layout: Layout, app: string): { config: DeployAppConfig | null; error: string | null } {
  try {
    return { config: loadConfig(layout, app), error: null };
  } catch (err) {
    return { config: null, error: (err as Error).message };
  }
}

/** Domains `app` would share with other apps on the server (spec §4: refused). */
export function domainConflicts(layout: Layout, app: string, domains: readonly string[], listed: readonly string[] = domains): DeployValidationIssue[] {
  const issues: DeployValidationIssue[] = [];
  for (const other of appNames(layout)) {
    if (other === app) continue;
    const { config } = tryLoadConfig(layout, other);
    if (!config) continue;
    for (const d of domains) {
      if (!config.domains.includes(d)) continue;
      const i = listed.indexOf(d);
      issues.push(
        i >= 0
          ? { path: `domains.${i}`, message: `${d} is already used by app ${other}` }
          : { path: 'redirect_www', message: `${d}, added for redirect_www, is already used by app ${other}; set redirect_www: none or move it to one app` },
      );
    }
  }
  return issues;
}

/** The domains as written in the config text, before redirect_www adds the other www names. */
function listedDomains(text: string): string[] {
  const value = parseYaml(text).value as { domains?: unknown } | null;
  return Array.isArray(value?.domains) ? value.domains.filter((d): d is string => typeof d === 'string') : [];
}

/** A host port `app` would publish that another app on the server publishes already (refused: only one can bind it). */
export function publishConflicts(layout: Layout, app: string, publish: DeployAppConfig['run']['publish']): DeployValidationIssue[] {
  if (publish.scope === 'none' || publish.port === null) return [];
  for (const other of appNames(layout)) {
    if (other === app) continue;
    const { config } = tryLoadConfig(layout, other);
    if (config && config.run.publish.port === publish.port) {
      return [{ path: 'run.publish', message: `Host port ${publish.port} is already published by app ${other}` }];
    }
  }
  return [];
}

/** Full validation of config text for `app` on this server: syntax, schema, the server's proxy mode, then domains and published ports across apps. */
export function validateForServer(layout: Layout, app: string, text: string): DeployValidation & { config: DeployAppConfig | null } {
  const { config, issues } = checkConfigText(text, app);
  if (!config) return { ok: false, errors: issues, config: null };
  const mode = proxyMode(layout);
  const conflicts = [...domainConflicts(layout, app, config.domains, listedDomains(text)), ...publishConflicts(layout, app, config.run.publish)];
  // Without domains the app never reaches the proxy, whichever mode it names
  if (config.proxy !== mode && config.domains.length > 0) conflicts.unshift({ path: 'proxy', message: `This server's proxy is set up for ${mode}; use proxy: ${mode}` });
  return { ok: conflicts.length === 0, errors: conflicts, config: conflicts.length === 0 ? config : null };
}

export function formatIssues(issues: readonly DeployValidationIssue[]): string {
  return issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
}

/** The starting config `init` writes when none is given. */
export function templateConfig(app: string, proxy: DeployAppConfig['proxy'] = 'caddy'): string {
  return [
    `name: ${app}`,
    `domains: [${app}.example.com]`,
    'redirect_www: none          # apex | www | none',
    'tls: auto                   # auto | staging | internal | dns:<provider> | { cert: path, key: path }',
    'build:',
    '  type: dockerfile          # nextjs | dockerfile | static',
    '  dir: .',
    'run:',
    '  port: 3000',
    '  env_file: .env',
    'healthcheck: { path: /, timeout: 30s }',
    'keep_releases: 5',
    `proxy: ${proxy}`,
    '',
  ].join('\n');
}

/** Where the app's env file is, checked to stay in the app folder. */
export function envFilePath(layout: Layout, app: string, config: Pick<DeployAppConfig, 'run'>): string {
  return path.join(layout.app(app), config.run.env_file);
}
