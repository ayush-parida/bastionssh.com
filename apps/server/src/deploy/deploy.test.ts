import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Client } from 'ssh2';
import { DeployError } from './errors.js';
import { DISCOVER_SCRIPT, discoverRoot, integrity, parseKeyValues, PREPARE_SCRIPT, prepareRoot } from './install.js';
import { bastionctlBundle, bastionctlVersionOf, type BastionctlBundle } from './bundle.js';
import type { Remote, RunResult } from './remote.js';
import { runOnClient } from './remote.js';
import { bastionctl, bastionctlCommand, parseResult } from './runner.js';

/** A Remote whose `run` answers from a function; files from a map. */
function remote(answer: (command: string, stdin?: string) => Partial<RunResult>, files: Record<string, string> = {}): Remote & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    server: { id: 's1', name: 'web-1' } as Remote['server'],
    async run(command, opts) {
      commands.push(command);
      return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1, ...answer(command, opts?.stdin) };
    },
    async hashFile(path) {
      return files[path] ?? null;
    },
    readFile: async () => null,
    writeFile: async () => {},
    upload: async () => 0,
    remove: async () => {},
    download: async () => null,
    release: () => {},
  };
}

describe('bastionctl command lines', () => {
  it('quotes every word and always asks for JSON', () => {
    expect(bastionctlCommand('/opt/bastion', ['deploy', 'site1', '--source', '/opt/bastion/tmp/upload-ab12.tar.gz'], "o'brien@example.com")).toBe(
      "'env' 'BASTION_ACTOR=o'\\''brien@example.com' '/opt/bastion/bin/bastionctl' 'deploy' 'site1' '--source' '/opt/bastion/tmp/upload-ab12.tar.gz' '--json'",
    );
    // A root with spaces is fine: the path after it is what is checked
    expect(bastionctlCommand('/home/a b/bastion', ['validate', 'x', '--file', '/home/a b/bastion/tmp/c.yml'], 'a')).toContain("'/home/a b/bastion/tmp/c.yml'");
  });

  it('refuses anything that could become an option or reach outside the root', () => {
    for (const bad of ['-rf', '--root=/', '--help', '/etc/passwd', '/opt/bastion/../etc/x', '/opt/bastion/tmp/$(id)', 'a b', '', 'x;y', '\n']) {
      expect(() => bastionctlCommand('/opt/bastion', ['status', bad], 'a'), JSON.stringify(bad)).toThrow(DeployError);
    }
  });

  it('reads the last stdout line as the result', () => {
    expect(parseResult('noise\n{"ok":true}\n')).toEqual({ ok: true });
    expect(parseResult('[1,2]')).toEqual([1, 2]);
    expect(parseResult('')).toBeNull();
    expect(parseResult('{"half":')).toBeNull();
    expect(parseResult('plain text')).toBeNull();
  });

  it('turns bastionctl errors into statuses, unless asked to keep them', async () => {
    const answer = (stdout: object, exitCode = 1) => remote(() => ({ stdout: JSON.stringify(stdout) + '\n', exitCode }));
    await expect(bastionctl(answer({ error: 'Usage', code: 2 }), '/r', ['status', 'a'], { actor: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(bastionctl(answer({ error: 'Invalid config', code: 3 }), '/r', ['status', 'a'], { actor: 'x' })).rejects.toMatchObject({ statusCode: 422 });
    await expect(bastionctl(answer({ error: 'locked', code: 4 }), '/r', ['status', 'a'], { actor: 'x' })).rejects.toMatchObject({ statusCode: 409, code: 'locked' });
    await expect(bastionctl(answer({ error: 'No app named a on this server', code: 1 }), '/r', ['status', 'a'], { actor: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    const kept = await bastionctl(answer({ error: 'x', code: 3 }), '/r', ['validate', 'a'], { actor: 'x', allowFailure: true });
    expect(kept.value).toEqual({ error: 'x', code: 3 });
    await expect(bastionctl(remote(() => ({ stdout: '', stderr: 'sh: docker: not found\n', exitCode: 127 })), '/r', ['list'], { actor: 'x' })).rejects.toMatchObject({
      statusCode: 502,
      message: 'bastionctl list failed: sh: docker: not found',
    });
    await expect(bastionctl(remote(() => ({ timedOut: true, exitCode: null })), '/r', ['list'], { actor: 'x' })).rejects.toMatchObject({ statusCode: 504 });
  });
});

describe('root directory and integrity', () => {
  it('runs the constant scripts and parses what they print', async () => {
    const r = remote((command) => ({ stdout: command.includes('for d in') ? 'root=/home/deploy/bastion\n' : '' }));
    expect(await discoverRoot(r)).toBe('/home/deploy/bastion');
    expect(r.commands[0]).toBe(`'sh' '-c' '${DISCOVER_SCRIPT.replace(/'/g, `'\\''`)}'`);
    expect(await discoverRoot(remote(() => ({ stdout: 'root=\n' })))).toBeNull();
    expect(parseKeyValues('root=/a=b\nsudo=yes\njunk\n')).toEqual({ root: '/a=b', sudo: 'yes' });
  });

  it('refuses a root it could not safely put in a command', async () => {
    for (const bad of ['relative/path', "/opt/it's", '/opt/../etc', '/opt/a\tb', '/opt/"x"']) {
      await expect(discoverRoot(remote(() => ({ stdout: `root=${bad}\n` })))).rejects.toThrow(/unusable/);
    }
  });

  it('reports what setup needs', async () => {
    const prepared = await prepareRoot(remote((command) => ({ stdout: command.includes('sudo_used') ? 'root=/opt/bastion\nsudo=yes\ndocker=yes\nsocket=sudo\n' : '' })));
    expect(prepared).toEqual({ root: '/opt/bastion', sudo: true, docker: true, socket: 'sudo' });
    expect(PREPARE_SCRIPT).not.toMatch(/\$\{?[a-z]*\}?\s*;\s*rm/);
    await expect(prepareRoot(remote(() => ({ exitCode: 1, stderr: 'mkdir: permission denied' })))).rejects.toThrow(/permission denied/);
  });

  it('compares both installed files with the shipped hashes', async () => {
    const bundle = { scriptSha256: 'aa', wrapperSha256: 'bb' } as BastionctlBundle;
    const at = (files: Record<string, string>) => integrity(remote(() => ({}), files), '/r', bundle);
    expect(await at({ '/r/bin/bastionctl.mjs': 'aa', '/r/bin/bastionctl': 'bb' })).toBe('ok');
    expect(await at({ '/r/bin/bastionctl.mjs': 'aa', '/r/bin/bastionctl': 'cc' })).toBe('mismatch');
    expect(await at({ '/r/bin/bastionctl.mjs': 'aa' })).toBe('missing');
  });
});

describe('running a command over SSH', () => {
  /** An ssh2 Client with one exec channel the test drives. */
  function client() {
    const channel = Object.assign(new PassThrough(), {
      stderr: new PassThrough(),
      signals: [] as string[],
      stdin: [] as unknown[],
      wasClosed: false,
      signal(name: string) {
        channel.signals.push(name);
      },
      close() {
        channel.wasClosed = true;
        channel.emit('close');
      },
    });
    // ssh2: end() is EOF on the remote stdin; the channel stays open
    channel.end = ((data?: unknown) => {
      channel.stdin.push(data);
      return channel;
    }) as typeof channel.end;
    const ssh = new EventEmitter() as unknown as Client & { command?: string };
    (ssh as unknown as { exec: Client['exec'] }).exec = ((command: string, cb: (err: Error | undefined, ch: unknown) => void) => {
      ssh.command = command;
      setImmediate(() => cb(undefined, channel));
      return ssh;
    }) as unknown as Client['exec'];
    return { ssh, channel };
  }

  it('streams lines, collects stdout, writes stdin then EOF, and reports the exit', async () => {
    const { ssh, channel } = client();
    const lines: string[] = [];
    const pending = runOnClient(ssh, 'cmd', { stdin: 'secret', onLine: (stream, line) => lines.push(`${stream}:${line}`) });
    await new Promise((r) => setImmediate(r));
    channel.stderr.write('step 1\nste');
    channel.stderr.write('p 2\n');
    channel.write('{"ok":true}');
    channel.emit('exit', 0);
    channel.emit('close');
    const result = await pending;
    expect(channel.stdin).toEqual(['secret']);
    expect(lines).toEqual(['stderr:step 1', 'stderr:step 2', 'stdout:{"ok":true}']);
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, stdout: '{"ok":true}', stderr: 'step 1\nstep 2\n' });
  });

  it('stops a command that runs past its timeout', async () => {
    const { ssh, channel } = client();
    const result = await runOnClient(ssh, 'sleep', { timeoutMs: 20 });
    expect(channel.signals).toEqual(['TERM']);
    expect(channel.wasClosed).toBe(true);
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
  });
});

describe('bastionctl versions', () => {
  it('reads the build from the banner, the plain version from an older program, and nothing from anything else', () => {
    expect(bastionctlVersionOf(Buffer.from("#!/usr/bin/env node\n// bastionctl 0.1.0+e53ab47\nimport x from 'y';\n"))).toBe('0.1.0+e53ab47');
    expect(bastionctlVersionOf(Buffer.from('#!/usr/bin/env node\nimport x;\nvar BASTIONCTL_VERSION = "0.1.0";\n'))).toBe('0.1.0');
    expect(bastionctlVersionOf(Buffer.from('var BASTIONCTL_VERSION = true ? "0.2.0+abcdef0" : "0.2.0";'))).toBe('0.2.0+abcdef0');
    expect(bastionctlVersionOf(Buffer.from('console.log("not ours")\n'))).toBeNull();
    expect(bastionctlVersionOf(Buffer.from('// bastionctl 0.1.0; rm -rf /\n'))).toBeNull();
  });

  it('gives the built bundle a build-aware version: 0.1.0+<first 7 hex of the bundle hash>', () => {
    const bundle = bastionctlBundle();
    // packages/bastionctl is built before the server's tests run
    expect(bundle?.version).toMatch(/^0\.1\.0\+[0-9a-f]{7}$/);
  });
});
