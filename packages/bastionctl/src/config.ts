import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type { DeployAppConfig, DeployBuildType, DeployValidation, DeployValidationIssue } from '@smt/shared';
import { NODE_BUILD_VERSIONS } from './images.js';
import { BastionError, Layout, NAME_PATTERN } from './names.js';
import { NGINX_TLS, proxyMode } from './nginx.js';

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

const BUILD_TYPES: readonly DeployBuildType[] = ['nextjs', 'dockerfile', 'static'];
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
} as const;

const KEYS = {
  root: ['name', 'domains', 'redirect_www', 'tls', 'build', 'run', 'healthcheck', 'keep_releases', 'proxy', 'permissions'],
  build: ['type', 'node', 'dir', 'output'],
  run: ['port', 'env_file', 'volumes', 'memory', 'cpus'],
  healthcheck: ['path', 'timeout'],
  tls: ['cert', 'key'],
  permissions: ['deploy'],
};

/** A domain Caddy can serve: lower-case labels, at least two, `*.` only as the first label. */
export function isDomain(value: string): boolean {
  if (value.length > 253) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  return labels.every((label, i) => (i === 0 && label === '*') || LABEL.test(label)) && !/^\d+$/.test(labels[labels.length - 1]!);
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
  if (!Array.isArray(data.domains) || data.domains.length === 0) {
    issues.add('domains', 'Required: a list of at least one domain');
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
  let build: DeployAppConfig['build'] = { type: 'dockerfile', node: null, dir: '.', output: null };
  if (!isObject(data.build)) {
    issues.add('build', 'Required: { type: nextjs | dockerfile | static }');
  } else {
    issues.unknownKeys(data.build, KEYS.build, 'build');
    const { type, node, dir, output } = data.build;
    if (typeof type !== 'string' || !(BUILD_TYPES as readonly string[]).includes(type)) {
      issues.add('build.type', 'Must be nextjs, dockerfile or static');
    }
    const known = (BUILD_TYPES as readonly unknown[]).includes(type);
    const buildType = known ? (type as DeployBuildType) : 'dockerfile';
    let nodeVersion: string | null = null;
    if (node !== undefined) {
      const v = typeof node === 'number' ? String(node) : node;
      if (known && buildType === 'dockerfile') issues.add('build.node', 'Only for nextjs and static builds (a Dockerfile picks its own base image)');
      else if (typeof v !== 'string' || !NODE_VERSION.test(v)) issues.add('build.node', 'A Node.js version like "20" or "22.11"');
      else if (!NODE_BUILD_VERSIONS.includes(v.split('.')[0]!)) issues.add('build.node', `Builds use Node.js ${NODE_BUILD_VERSIONS.join(', ')}`);
      else nodeVersion = v;
    }
    let buildDir = '.';
    if (dir !== undefined) {
      if (typeof dir !== 'string' || !isSafeRelative(dir)) issues.add('build.dir', 'A relative path inside the upload, without ..');
      else buildDir = dir;
    }
    let buildOutput: string | null = buildType === 'static' ? 'out' : null;
    if (output !== undefined) {
      if (known && buildType !== 'static') issues.add('build.output', 'Only for static builds');
      else if (typeof output !== 'string' || !isSafeRelative(output)) issues.add('build.output', 'A relative path inside build.dir, without ..');
      else buildOutput = output;
    }
    build = { type: buildType, node: nodeVersion, dir: buildDir, output: buildOutput };
  }

  // run
  const run: DeployAppConfig['run'] = { port: DEFAULTS.port, env_file: DEFAULTS.env_file, volumes: [], memory: null, cpus: null };
  if (data.run !== undefined) {
    if (!isObject(data.run)) {
      issues.add('run', 'Must be a mapping');
    } else {
      issues.unknownKeys(data.run, KEYS.run, 'run');
      const { port, env_file, volumes, memory, cpus } = data.run;
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
          issues.add('run.volumes', 'A list like ["uploads:/app/uploads"]');
        } else {
          const names = new Set<string>();
          volumes.forEach((v, i) => {
            const m = typeof v === 'string' ? VOLUME.exec(v) : null;
            if (!m) return issues.add(`run.volumes.${i}`, 'Use <name>:/absolute/path[:ro] — named volumes only, never host paths');
            const target = m[2]!;
            if (target === '/' || target.split('/').some((seg) => seg === '..' || seg === '.')) {
              return issues.add(`run.volumes.${i}`, 'The container path must be absolute, not /, and without . or ..');
            }
            if (names.has(m[1]!)) return issues.add(`run.volumes.${i}`, `Volume ${m[1]} is listed twice`);
            names.add(m[1]!);
            run.volumes.push(v as string);
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
    }
  }
  if (build.type === 'static') run.port = 80;

  // healthcheck
  const healthcheck = { path: DEFAULTS.healthPath as string, timeout: DEFAULTS.healthTimeout as string };
  if (data.healthcheck !== undefined) {
    if (!isObject(data.healthcheck)) {
      issues.add('healthcheck', 'Must be a mapping');
    } else {
      issues.unknownKeys(data.healthcheck, KEYS.healthcheck, 'healthcheck');
      const { path: hPath, timeout } = data.healthcheck;
      if (hPath !== undefined) {
        // eslint-disable-next-line no-control-regex
        if (typeof hPath !== 'string' || !hPath.startsWith('/') || hPath.length > 200 || /[\s\0-\x1f'"`\\]/.test(hPath)) {
          issues.add('healthcheck.path', 'A URL path starting with /, without spaces or quotes');
        } else healthcheck.path = hPath;
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

  // certbot's webroot challenge on the host: no wildcards, no DNS providers, no internal CA
  if (proxy === 'nginx' && (typeof tls !== 'string' || !(NGINX_TLS as readonly string[]).includes(tls))) {
    issues.add('tls', 'With proxy: nginx, tls must be auto or staging (certificates come from certbot on the host)');
  }

  if (issues.list.length > 0) return { config: null, issues: issues.list };
  return {
    config: {
      name: name as string,
      domains,
      redirect_www: redirect,
      tls,
      build,
      run,
      healthcheck,
      keep_releases: keep,
      proxy,
      permissions,
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
export function domainConflicts(layout: Layout, app: string, domains: readonly string[]): DeployValidationIssue[] {
  const issues: DeployValidationIssue[] = [];
  for (const other of appNames(layout)) {
    if (other === app) continue;
    const { config } = tryLoadConfig(layout, other);
    if (!config) continue;
    domains.forEach((d, i) => {
      if (config.domains.includes(d)) issues.push({ path: `domains.${i}`, message: `${d} is already used by app ${other}` });
    });
  }
  return issues;
}

/** Full validation of config text for `app` on this server: syntax, schema, the server's proxy mode, then domains across apps. */
export function validateForServer(layout: Layout, app: string, text: string): DeployValidation & { config: DeployAppConfig | null } {
  const { config, issues } = checkConfigText(text, app);
  if (!config) return { ok: false, errors: issues, config: null };
  const mode = proxyMode(layout);
  const conflicts = domainConflicts(layout, app, config.domains);
  if (config.proxy !== mode) conflicts.unshift({ path: 'proxy', message: `This server's proxy is set up for ${mode}; use proxy: ${mode}` });
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
