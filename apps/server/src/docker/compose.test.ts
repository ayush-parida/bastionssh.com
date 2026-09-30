import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { Client } from 'ssh2';
import {
  claimProject,
  composeArgv,
  composeCommand,
  composeDisplay,
  discoverProjects,
  logSource,
  projectFilter,
  projectName,
  runCompose,
  serviceName,
  splitConfigFiles,
  type ComposeTarget,
} from './compose.js';
import { shellCommand } from './shell.js';

const project = (over: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  Id: 'c'.repeat(64),
  Names: ['/shop-web-1'],
  Image: 'nginx',
  State: 'running',
  Status: 'Up 1 hour (healthy)',
  Labels: {
    'com.docker.compose.project': 'shop',
    'com.docker.compose.service': 'web',
    'com.docker.compose.container-number': '1',
    'com.docker.compose.project.working_dir': '/srv/shop',
    'com.docker.compose.project.config_files': '/srv/shop/compose.yaml,/srv/shop/compose.prod.yaml',
    ...over,
  },
  ...extra,
});

/** Values a hostile label could carry: shell syntax of every kind, and option look-alikes. */
const HOSTILE = [
  "it's",
  "'; touch PWNED; '",
  '$(touch PWNED)',
  '`touch PWNED`',
  '${IFS}touch${IFS}PWNED',
  'a;b|c&d>e<f',
  '--rm -rf',
  '-f',
  '"double" \\back\\slash',
  'new\nline',
  '* ? [a-z] ~',
  '!event',
];

describe('shell quoting', () => {
  it('passes every hostile value through a real sh as one untouched argument', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-quote-'));
    try {
      const out = execFileSync('/bin/sh', ['-c', shellCommand(['printf', '%s\\0', ...HOSTILE])], { cwd: dir });
      expect(out.toString().split('\0').slice(0, -1)).toEqual(HOSTILE);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses NUL bytes', () => {
    expect(() => shellCommand(['a\0b'])).toThrow(/NUL/);
  });
});

describe('discovery', () => {
  it('groups containers into projects and services with state', () => {
    const projects = discoverProjects([
      project(),
      project({ 'com.docker.compose.container-number': '2' }, { Id: 'd'.repeat(64), Names: ['/shop-web-2'], State: 'exited', Status: 'Exited (0)' }),
      project({ 'com.docker.compose.service': 'db', 'com.docker.compose.container-number': '1' }, { Names: ['/shop-db-1'] }),
      project({ 'com.docker.compose.oneoff': 'True' }, { Names: ['/shop-web-run-1'] }),
      { Id: 'e'.repeat(64), Names: ['/loose'], State: 'running', Labels: {} },
    ]);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      name: 'shop',
      workingDir: '/srv/shop',
      configFiles: ['/srv/shop/compose.yaml', '/srv/shop/compose.prod.yaml'],
      unmanageable: null,
      running: 2,
      total: 3,
      state: 'partial',
    });
    expect(projects[0]!.services.map((s) => [s.name, s.containers.map((c) => c.name), s.running])).toEqual([
      ['db', ['shop-db-1'], 1],
      ['web', ['shop-web-1', 'shop-web-2'], 1],
    ]);
    expect(projects[0]!.services[1]!.containers[0]).toMatchObject({ number: 1, health: 'healthy' });
  });

  it('lists projects it cannot act on, saying why', () => {
    const reason = (labels: Record<string, string>) => discoverProjects([project(labels)])[0]!.unmanageable;
    expect(reason({ 'com.docker.compose.project.working_dir': '' })).toMatch(/working directory/);
    expect(reason({ 'com.docker.compose.project.working_dir': 'relative/dir' })).toMatch(/absolute path/);
    expect(reason({ 'com.docker.compose.project.working_dir': '/srv/a\nb' })).toMatch(/absolute path/);
    expect(reason({ 'com.docker.compose.project.config_files': '' })).toMatch(/compose files/);
    expect(reason({ 'com.docker.compose.project.config_files': '--file=/etc/shadow' })).toMatch(/compose file/);
    expect(reason({ 'com.docker.compose.project': 'Shop; rm -rf /' })).toMatch(/project name/);
    // Containers of one project that disagree about where it lives
    const split = discoverProjects([project(), project({ 'com.docker.compose.project.working_dir': '/elsewhere' })]);
    expect(split[0]!.unmanageable).toMatch(/disagree/);
    expect(split[0]!.workingDir).toBeNull();
  });

  it('splits config files and builds label filters', () => {
    expect(splitConfigFiles(' /a.yml, ,/b.yml ')).toEqual(['/a.yml', '/b.yml']);
    expect(splitConfigFiles(undefined)).toEqual([]);
    expect(JSON.parse(projectFilter('shop'))).toEqual({ label: ['com.docker.compose.project=shop'] });
    expect(JSON.parse(projectFilter())).toEqual({ label: ['com.docker.compose.project'] });
  });

  it('names log sources like compose does', () => {
    expect(logSource('web', { name: 'shop-web-2', number: 2 })).toBe('web-2');
    expect(logSource('web', { name: 'custom', number: null })).toBe('custom');
  });
});

describe('validation', () => {
  it('accepts compose project and service names only', () => {
    expect(projectName('shop_2-prod')).toBe('shop_2-prod');
    for (const bad of ['', 'Shop', '-p', 'a b', 'a;b', '$(id)', '../x', 'a\nb', 'x'.repeat(256), 42]) {
      expect(() => projectName(bad), String(bad)).toThrow(/Invalid compose project name/);
    }
    expect(serviceName('Web.api_1')).toBe('Web.api_1');
    expect(() => serviceName('-x')).toThrow();
  });
});

describe('command building', () => {
  const target: ComposeTarget = { project: { name: 'shop', workingDir: '/srv/shop', configFiles: ['/srv/shop/compose.yaml'] }, socketPath: '/var/run/docker.sock' };

  it('runs only the fixed verbs, with flags that cannot be split', () => {
    expect(composeArgv(target, 'up').slice(5)).toEqual([
      'env',
      'DOCKER_HOST=unix:///var/run/docker.sock',
      'docker',
      'compose',
      '--ansi=never',
      '--project-name=shop',
      '--project-directory=/srv/shop',
      '--file=/srv/shop/compose.yaml',
      'up',
      '--detach',
    ]);
    expect(composeArgv(target, 'down').slice(-1)).toEqual(['down']);
    expect(composeArgv(target, 'pull').slice(-1)).toEqual(['pull']);
    expect(composeArgv(target, 'restart').slice(-1)).toEqual(['restart']);
    for (const verb of ['exec', 'run', 'rm', 'up; id', 'constructor', '__proto__']) {
      expect(() => composeArgv(target, verb as 'up'), verb).toThrow(/Unknown compose action/);
    }
    expect(composeDisplay(target.project, 'up')).toBe('docker compose -p shop up --detach');
  });

  it('refuses unusable labels even when a caller skips discovery', () => {
    const withProject = (p: Partial<typeof target.project>) => ({ ...target, project: { ...target.project, ...p } });
    expect(() => composeArgv(withProject({ name: '-p evil' }), 'up')).toThrow(/project name/);
    expect(() => composeArgv(withProject({ workingDir: null }), 'up')).toThrow(/working directory/);
    expect(() => composeArgv(withProject({ workingDir: '-C /' }), 'up')).toThrow(/working directory/);
    expect(() => composeArgv(withProject({ configFiles: [] }), 'up')).toThrow(/compose files/);
    expect(() => composeArgv(withProject({ configFiles: ['/a\n/b'] }), 'up')).toThrow(/compose files/);
    expect(() => composeArgv({ ...target, socketPath: 'tcp://evil' }, 'up')).toThrow(/socket/);
  });

  describe('through a real shell', () => {
    let root: string;
    let bin: string;

    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-compose-'));
      bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      // Stands in for the docker CLI: where it ran, what it got, and DOCKER_HOST
      fs.writeFileSync(
        path.join(bin, 'docker'),
        '#!/bin/sh\nprintf "%s\\0" "$(pwd)" "$DOCKER_HOST" "$@"\n',
        { mode: 0o755 },
      );
    });
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    const hostileDirs = HOSTILE.filter((v) => !v.includes('\n')).map((v, i) => `d${i} ${v}`);

    it.each(hostileDirs)('keeps a hostile working dir and file names literal: %j', (name) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      const files = [path.join(dir, `${name}.yaml`), path.join(dir, '--help')];
      const command = composeCommand(
        { project: { name: 'shop', workingDir: dir, configFiles: files }, socketPath: '/run/user/1000/docker.sock' },
        'up',
      );
      const out = execFileSync('/bin/sh', ['-c', command], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      const [pwd, dockerHost, ...args] = out.toString().split('\0').slice(0, -1);
      expect(fs.realpathSync(pwd!)).toBe(fs.realpathSync(dir));
      expect(dockerHost).toBe('unix:///run/user/1000/docker.sock');
      expect(args).toEqual([
        'compose',
        '--ansi=never',
        '--project-name=shop',
        `--project-directory=${dir}`,
        `--file=${files[0]}`,
        `--file=${files[1]}`,
        'up',
        '--detach',
      ]);
      // Nothing in any name was executed
      const created = fs.readdirSync(root, { recursive: true }).map(String);
      expect(created.filter((f) => path.basename(f) === 'PWNED')).toEqual([]);
      expect(fs.readdirSync(dir)).toEqual([]);
    });
  });
});

describe('runCompose', () => {
  /** An ssh2 client whose exec channel prints, exits with `code`, then closes. */
  function fakeSsh(script: (channel: PassThrough & { stderr: PassThrough }) => void) {
    const commands: string[] = [];
    const signals: string[] = [];
    const stdin = { ended: false };
    const client = {
      exec(command: string, cb: (err: Error | undefined, channel: unknown) => void) {
        commands.push(command);
        const channel = Object.assign(new PassThrough(), {
          stderr: new PassThrough(),
          close: () => channel.emit('close'),
          signal: (name: string) => signals.push(name),
          // ssh2: EOF on the remote stdin; the channel stays open
          end: () => {
            stdin.ended = true;
            return channel;
          },
        });
        setImmediate(() => {
          cb(undefined, channel);
          script(channel);
        });
      },
    };
    return { client: client as unknown as Client, commands, signals, stdin };
  }

  it('streams lines per stream and resolves with the exit code', async () => {
    const { client, commands } = fakeSsh((ch) => {
      ch.write('Pulling web');
      ch.write(' ... done\nsecond');
      ch.stderr.write('warn: x\n');
      ch.emit('exit', 3);
      ch.emit('close');
    });
    const got: Array<[string, string[]]> = [];
    const result = await runCompose(client, 'cmd', { onLines: (s, l) => got.push([s, l]) });
    expect(commands).toEqual(['cmd']);
    expect(result).toMatchObject({ exitCode: 3, signal: null, timedOut: false });
    expect(got).toEqual([
      ['stdout', ['Pulling web ... done']],
      ['stderr', ['warn: x']],
      ['stdout', ['second']],
    ]);
  });

  it('stops the command and closes the channel on timeout, reporting no exit code', async () => {
    const { client, signals } = fakeSsh(() => {});
    const result = await runCompose(client, 'cmd', { onLines: () => {}, timeoutMs: 20 });
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(signals).toEqual(['TERM']);
  });

  it('closes stdin at once, so a prompt cannot hold the action open', async () => {
    const { client, stdin } = fakeSsh((ch) => {
      ch.emit('exit', 0);
      ch.emit('close');
    });
    await runCompose(client, 'cmd', { onLines: () => {} });
    expect(stdin.ended).toBe(true);
  });

  it('reports a channel that could not open', async () => {
    const client = { exec: (_c: string, cb: (err: Error) => void) => cb(new Error('Channel open failure')) } as unknown as Client;
    await expect(runCompose(client, 'cmd', { onLines: () => {} })).rejects.toMatchObject({ statusCode: 502 });
  });

  it('resolves with no exit code when the connection drops', async () => {
    const emitter = new EventEmitter();
    const { client } = fakeSsh((ch) => emitter.once('drop', () => ch.emit('close')));
    const pending = runCompose(client, 'cmd', { onLines: () => {} });
    await new Promise((r) => setTimeout(r, 5));
    emitter.emit('drop');
    expect(await pending).toMatchObject({ exitCode: null, timedOut: false });
  });
});

describe('claimProject', () => {
  it('lets one action run per project and server', () => {
    const release = claimProject('s1', 'shop')!;
    expect(release).toBeTypeOf('function');
    expect(claimProject('s1', 'shop')).toBeNull();
    const other = claimProject('s2', 'shop')!;
    expect(other).not.toBeNull();
    release();
    release();
    const again = claimProject('s1', 'shop');
    expect(again).not.toBeNull();
    again!();
    other();
  });
});
