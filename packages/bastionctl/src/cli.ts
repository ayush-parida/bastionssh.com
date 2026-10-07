import path from 'node:path';
import { certs } from './certs.js';
import type { Ctx } from './context.js';
import { DEFAULT_SOCKET, DockerApi } from './docker.js';
import { MAX_VALUE_BYTES } from './env.js';
import { appName, BastionError, envKey, Layout, releaseId } from './names.js';
import * as ops from './ops.js';

/**
 * Command-line parsing (deployments spec §5). Everything is strict: unknown
 * commands and flags are usage errors (exit 2), app names, release ids and
 * variable names are validated before use. Progress goes to stderr; with
 * `--json` the result (or `{ error }`) is one JSON line on stdout, which is
 * what BastionSSH reads.
 */

export const USAGE = `Usage: bastionctl <command> [options] [--json]

  setup [--proxy caddy|nginx]             Network, proxy container and folders (safe to repeat)
  init <app> [--config <file>] [--force]  Create an app (template, or a bastion.yml file)
  validate <app> [--file <file>]          Check a config (default: the app's bastion.yml)
  list                                    Apps with their current release and container
  status <app>                            One app in detail
  releases <app>                          An app's releases, newest first
  certs <app>                             Certificates of the app's domains (issuer, expiry, last error)
  deploy <app> --source <file>            Build and serve an upload (.tar or .tar.gz)
  deploy <app>                            Pull and serve build.image (build.type: image)
  rollback <app> <release>                Serve a kept release again (no rebuild)
  restart <app> | stop <app>              The app's live container
  env keys|set|unset|get <app> [KEY]      .env: names only; set reads the value from stdin
  env generate <app> <KEY> [--bytes N] [--if-missing]
                                          A random URL-safe value into .env (never printed)
  exec <app> -- <program> [args…]         Run a program in the app's live container
  delete <app> [--purge]                  Remove an app (--purge: also config, .env, volumes)
  proxy apply                             Regenerate and reload the proxy config
  proxy status                            The proxy against this bastionctl (read-only)
  proxy upgrade                           Replace an outdated proxy now (even when pinned)
  version

Commands that change traffic (deploy, rollback, restart, proxy apply, setup)
first upgrade a proxy left by an older bastionctl, unless bin/.pinned exists.

Files must be inside the root directory (${'$'}BASTION_ROOT).`;

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['source', 'config', 'file', 'drain', 'root', 'proxy', 'bytes']);
const BOOL_FLAGS = new Set(['json', 'force', 'purge', 'help', 'if-missing']);

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (VALUE_FLAGS.has(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '') throw new BastionError(`--${name} needs a value`, 2);
      flags.set(name, value);
    } else if (BOOL_FLAGS.has(name) && eq === -1) {
      flags.set(name, true);
    } else {
      throw new BastionError(`Unknown option ${arg}`, 2);
    }
  }
  return { positional, flags };
}

function expect(positional: string[], count: number, usage: string): void {
  if (positional.length !== count) throw new BastionError(`Usage: bastionctl ${usage}`, 2);
}

function flag(parsed: Parsed, name: string): string | undefined {
  const v = parsed.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

/** Who to record: BASTION_ACTOR (set by BastionSSH), else the user name. */
export function actorFrom(env: NodeJS.ProcessEnv): string {
  const raw = env.BASTION_ACTOR ?? env.USER ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\0-\x1f\x7f]/g, '').slice(0, 200).trim();
  return clean || 'cli';
}

export interface CliIo {
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: (max: number) => Promise<string>;
  /** Raw output of `exec` (binary-safe); `stdout`/`stderr` with the text decoded when absent. */
  writeStdout?: (chunk: Buffer) => void;
  writeStderr?: (chunk: Buffer) => void;
  /** Tests pass their own (fake Docker API, temp root, no drain). */
  ctx?: Partial<Ctx>;
}

/** Run one command; returns the exit code. */
export async function run(argv: string[], io: CliIo): Promise<number> {
  // Everything after `--` is exec's argv, never bastionctl's options
  const dashes = argv.indexOf('--');
  const own = dashes === -1 ? argv : argv.slice(0, dashes);
  const passed = dashes === -1 ? null : argv.slice(dashes + 1);
  let json = own.includes('--json');
  const report: NonNullable<Ctx['report']> = {};
  try {
    const parsed = parseArgs(own);
    json = parsed.flags.has('json');
    const [command, ...rest] = parsed.positional;
    if (!command || parsed.flags.has('help') || command === 'help') {
      io.stdout(USAGE + '\n');
      return command ? 0 : 2;
    }
    const rootArg = flag(parsed, 'root') ?? io.env.BASTION_ROOT;
    if (!rootArg && command !== 'version') throw new BastionError('Set BASTION_ROOT or pass --root', 2);
    const drain = flag(parsed, 'drain');
    if (drain !== undefined && !/^\d{1,3}$/.test(drain)) throw new BastionError('--drain takes whole seconds (0–999)', 2);
    const ctx: Ctx = {
      layout: new Layout(path.resolve(rootArg ?? '/')),
      docker: new DockerApi(io.env.BASTION_DOCKER_SOCKET || DEFAULT_SOCKET),
      log: (line) => io.stderr(line + '\n'),
      actor: actorFrom(io.env),
      now: () => new Date(),
      drainMs: (drain !== undefined ? Number(drain) : 10) * 1000,
      healthIntervalMs: 1000,
      report,
      ...io.ctx,
    };
    if (passed !== null && command !== 'exec') throw new BastionError(`Only exec takes arguments after --`, 2);
    const result = await dispatch(ctx, command, rest, parsed, io, passed);
    if (json) io.stdout(JSON.stringify(withReport(result.value, ctx.report ?? report)) + '\n');
    else if (result.text !== undefined) io.stdout(result.text);
    return result.exitCode ?? 0;
  } catch (err) {
    const exitCode = err instanceof BastionError ? err.exitCode : 1;
    const message = err instanceof Error ? err.message : String(err);
    const details = err instanceof BastionError && err.details ? err.details : {};
    if (json) io.stdout(JSON.stringify({ ...(report.proxyUpgrade && { proxyUpgrade: report.proxyUpgrade }), ...details, error: message, code: exitCode }) + '\n');
    io.stderr(`bastionctl: ${message}\n`);
    return exitCode;
  }
}

/** A result object with what the command did besides (a proxy upgrade), for BastionSSH's audit. */
function withReport(value: unknown, report: NonNullable<Ctx['report']>): unknown {
  if (!report.proxyUpgrade || typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  return { ...value, proxyUpgrade: report.proxyUpgrade };
}

interface Result {
  value: unknown;
  text?: string;
  exitCode?: number;
}

const lines = (rows: string[]) => (rows.length ? rows.join('\n') + '\n' : '');

async function dispatch(ctx: Ctx, command: string, args: string[], parsed: Parsed, io: CliIo, passed: string[] | null): Promise<Result> {
  switch (command) {
    case 'version': {
      const v = ops.version();
      return { value: v, text: `bastionctl ${v.version} (node ${v.node})\n` };
    }
    case 'setup': {
      expect(args, 0, 'setup [--proxy caddy|nginx]');
      const proxy = flag(parsed, 'proxy');
      if (proxy !== undefined && proxy !== 'caddy' && proxy !== 'nginx') throw new BastionError('--proxy is caddy or nginx', 2);
      const r = await ops.setup(ctx, { proxy });
      return { value: r, text: `Ready: ${r.root} (${r.proxy} mode, proxy ${r.proxyContainer?.state ?? 'missing'})\n` };
    }
    case 'init': {
      expect(args, 1, 'init <app> [--config <file>] [--force]');
      const r = await ops.init(ctx, appName(args[0]), { config: flag(parsed, 'config'), force: parsed.flags.has('force') });
      return { value: r };
    }
    case 'validate': {
      expect(args, 1, 'validate <app> [--file <file>]');
      const r = ops.validate(ctx, appName(args[0]), flag(parsed, 'file'));
      return { value: r, text: r.ok ? 'Valid\n' : lines(r.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message))), exitCode: r.ok ? 0 : 3 };
    }
    case 'list': {
      expect(args, 0, 'list');
      const r = await ops.list(ctx);
      return { value: r, text: lines(r.map((a) => `${a.name}\t${a.currentRelease ?? '-'}\t${a.container?.state ?? '-'}\t${a.domains.join(',')}`)) };
    }
    case 'status': {
      expect(args, 1, 'status <app>');
      const r = await ops.status(ctx, appName(args[0]));
      return { value: r, text: JSON.stringify(r, null, 2) + '\n' };
    }
    case 'releases': {
      expect(args, 1, 'releases <app>');
      const r = await ops.releases(ctx, appName(args[0]));
      return { value: r, text: lines(r.map((x) => `${x.current ? '*' : ' '} ${x.id}\t${x.result}\t${x.actor}`)) };
    }
    case 'certs': {
      expect(args, 1, 'certs <app>');
      const r = await certs(ctx, appName(args[0]));
      return { value: r, text: lines(r.map((c) => `${c.domain}\t${c.issuer ?? 'no certificate'}\t${c.notAfter ?? '-'}${c.lastError ? `\t${c.lastError.message}` : ''}`)) };
    }
    case 'deploy': {
      expect(args, 1, 'deploy <app> [--source <file>]');
      const r = await ops.deploy(ctx, appName(args[0]), flag(parsed, 'source'));
      return { value: r, exitCode: r.result === 'success' ? 0 : 1 };
    }
    case 'rollback': {
      expect(args, 2, 'rollback <app> <release>');
      const r = await ops.rollback(ctx, appName(args[0]), releaseId(args[1]));
      return { value: r, exitCode: r.result === 'success' ? 0 : 1 };
    }
    case 'restart':
    case 'stop': {
      expect(args, 1, `${command} <app>`);
      const app = appName(args[0]);
      return { value: command === 'restart' ? await ops.restart(ctx, app) : await ops.stop(ctx, app) };
    }
    case 'delete': {
      expect(args, 1, 'delete <app> [--purge]');
      return { value: await ops.remove(ctx, appName(args[0]), { purge: parsed.flags.has('purge') }) };
    }
    case 'proxy': {
      if (args.length !== 1 || !['apply', 'status', 'upgrade'].includes(args[0]!)) throw new BastionError('Usage: bastionctl proxy apply|status|upgrade', 2);
      if (args[0] === 'status') {
        const r = await ops.proxyStatusCommand(ctx);
        return { value: r, text: `${r.state}${r.outdated.length ? ` (${r.outdated.join(', ')})` : ''}: proxy from bastionctl ${r.build ?? '-'}, this is ${r.target}${r.pinned ? ' (pinned)' : ''}\n` };
      }
      if (args[0] === 'upgrade') {
        const r = await ops.proxyUpgrade(ctx);
        return { value: r, text: r.proxyUpgrade ? `Upgraded (${r.proxyUpgrade.replaced.join(', ')}) from ${r.proxyUpgrade.from} to ${r.proxyUpgrade.to}\n` : 'Up to date\n' };
      }
      return { value: await ops.proxyApply(ctx) };
    }
    case 'exec': {
      expect(args, 1, 'exec <app> -- <program> [args…]');
      if (!passed) throw new BastionError('Usage: bastionctl exec <app> -- <program> [args…]', 2);
      const json = parsed.flags.has('json');
      const toStdout = io.writeStdout ?? ((c: Buffer) => io.stdout(c.toString('utf8')));
      const toStderr = io.writeStderr ?? ((c: Buffer) => io.stderr(c.toString('utf8')));
      // With --json stdout carries only the result line: the program's output goes to stderr
      const r = await ops.execInApp(ctx, appName(args[0]), passed, { stdout: json ? toStderr : toStdout, stderr: toStderr });
      return { value: r, exitCode: r.exitCode === 0 ? 0 : r.exitCode > 0 && r.exitCode < 256 ? r.exitCode : 1 };
    }
    case 'env': {
      const [sub, app, key] = args;
      if (sub === 'keys') {
        expect(args, 2, 'env keys <app>');
        const r = ops.envKeys(ctx, appName(app));
        return { value: r, text: lines(r.keys) };
      }
      if (sub === 'set' || sub === 'unset' || sub === 'get') {
        expect(args, 3, `env ${sub} <app> <KEY>`);
        const a = appName(app);
        const k = envKey(key);
        if (sub === 'get') {
          const r = ops.envGet(ctx, a, k);
          return { value: r, text: r.value };
        }
        if (sub === 'unset') return { value: ops.envUnset(ctx, a, k) };
        // The value never appears on a command line (ps, shell history, audit)
        const value = await io.readStdin(MAX_VALUE_BYTES + 1);
        return { value: ops.envSet(ctx, a, k, value) };
      }
      if (sub === 'generate') {
        expect(args, 3, 'env generate <app> <KEY> [--bytes N] [--if-missing]');
        const bytes = flag(parsed, 'bytes');
        if (bytes !== undefined && !/^\d{1,4}$/.test(bytes)) throw new BastionError('--bytes takes a whole number', 2);
        const r = ops.envGenerate(ctx, appName(app), envKey(key), { bytes: bytes === undefined ? undefined : Number(bytes), ifMissing: parsed.flags.has('if-missing') });
        return { value: r, text: r.generated ? `Generated ${r.key}\n` : `${r.key} is set already; left as it is\n` };
      }
      throw new BastionError('Usage: bastionctl env keys|set|unset|get|generate <app> [KEY]', 2);
    }
    default:
      throw new BastionError(`Unknown command ${command}\n\n${USAGE}`, 2);
  }
}

/** Read stdin up to `max` bytes (a value for `env set`). */
export function readProcessStdin(max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    process.stdin.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        process.stdin.destroy();
        reject(new BastionError(`Value is larger than ${MAX_VALUE_BYTES / 1024} KiB`));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}
