import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConfigText, domainConflicts, isDomain, isSafeRelative, validateForServer } from './config.js';
import { Layout } from './names.js';

const valid = `
name: site1
domains: [site1.com, www.site1.com]
redirect_www: apex
tls: auto
build:
  type: nextjs
  node: "20"
  dir: .
run:
  port: 3000
  env_file: .env
  volumes: ["uploads:/app/public/uploads"]
  memory: 512m
  cpus: 1
healthcheck: { path: /, timeout: 30s }
keep_releases: 5
proxy: caddy
`;

const paths = (text: string, app: string | null = 'site1') => checkConfigText(text, app).issues.map((i) => i.path);

describe('bastion.yml validation', () => {
  it('accepts the spec example and fills in nothing it was given', () => {
    const { config, issues } = checkConfigText(valid, 'site1');
    expect(issues).toEqual([]);
    expect(config).toEqual({
      name: 'site1',
      domains: ['site1.com', 'www.site1.com'],
      redirect_www: 'apex',
      tls: 'auto',
      build: { type: 'nextjs', node: '20', dir: '.', output: null },
      run: { port: 3000, env_file: '.env', volumes: ['uploads:/app/public/uploads'], memory: '512m', cpus: 1 },
      healthcheck: { path: '/', timeout: '30s' },
      keep_releases: 5,
      proxy: 'caddy',
    });
  });

  it('fills in defaults for a minimal config', () => {
    const { config } = checkConfigText('name: a\ndomains: [a.example.com]\nbuild: { type: dockerfile }\n', 'a');
    expect(config).toMatchObject({ redirect_www: 'none', tls: 'auto', run: { port: 3000, env_file: '.env', volumes: [] }, keep_releases: 5, proxy: 'caddy' });
    // static apps are served by Caddy on 80, from out/ unless told otherwise
    expect(checkConfigText('name: a\ndomains: [a.example.com]\nbuild: { type: static }\n', 'a').config).toMatchObject({ build: { output: 'out' }, run: { port: 80 } });
  });

  it('refuses unknown keys at every level', () => {
    expect(paths(`${valid}\nimage: nginx\n`)).toEqual(['image']);
    expect(paths(valid.replace('  port: 3000', '  port: 3000\n  privileged: true'))).toEqual(['run.privileged']);
    expect(paths(valid.replace('type: nextjs', 'type: nextjs\n  args: [x]'))).toEqual(['build.args']);
    expect(paths(valid.replace('{ path: /, timeout: 30s }', '{ path: /, timeout: 30s, cmd: x }'))).toEqual(['healthcheck.cmd']);
  });

  it('checks the name, and that it is the app’s', () => {
    expect(paths(valid, 'other')).toEqual(['name']);
    expect(paths(valid.replace('name: site1', 'name: Site_1'))).toEqual(['name']);
    expect(paths(valid.replace('name: site1', 'name: ../x'))).toEqual(['name']);
  });

  it('checks domain syntax, duplicates and wildcards', () => {
    expect(isDomain('site1.com')).toBe(true);
    expect(isDomain('a-b.c.example.org')).toBe(true);
    for (const bad of ['localhost', 'Site.com', 'a..com', '-a.com', 'a.com.', '1.2.3.4', 'a com', 'a.com{', 'a.com\nb.com', 'x'.repeat(64) + '.com']) {
      expect(isDomain(bad), bad).toBe(false);
    }
    expect(paths(valid.replace('[site1.com, www.site1.com]', '[site1.com, "evil.com {\\n  respond 200\\n}"]'))).toEqual(['domains.1']);
    expect(paths(valid.replace('[site1.com, www.site1.com]', '[site1.com, site1.com]'))).toEqual(['domains.1']);
    expect(paths(valid.replace('[site1.com, www.site1.com]', '[]'))).toEqual(['domains']);
    // A wildcard needs a certificate that can cover it
    expect(paths(valid.replace('[site1.com, www.site1.com]', '["*.site1.com"]'))).toEqual(['domains.0']);
    expect(paths(valid.replace('[site1.com, www.site1.com]', '["*.site1.com"]').replace('tls: auto', 'tls: dns:cloudflare'))).toEqual([]);
  });

  it('checks ports, memory, cpus, timeouts and keep_releases', () => {
    expect(paths(valid.replace('port: 3000', 'port: 0'))).toEqual(['run.port']);
    expect(paths(valid.replace('port: 3000', 'port: 65536'))).toEqual(['run.port']);
    expect(paths(valid.replace('port: 3000', 'port: "3000"'))).toEqual(['run.port']);
    expect(paths(valid.replace('memory: 512m', 'memory: 1k'))).toEqual(['run.memory']);
    expect(paths(valid.replace('memory: 512m', 'memory: lots'))).toEqual(['run.memory']);
    expect(paths(valid.replace('cpus: 1', 'cpus: 0'))).toEqual(['run.cpus']);
    expect(paths(valid.replace('timeout: 30s', 'timeout: 1h'))).toEqual(['healthcheck.timeout']);
    expect(paths(valid.replace('timeout: 30s', 'timeout: 11m'))).toEqual(['healthcheck.timeout']);
    expect(paths(valid.replace('path: /', "path: \"/x'; rm\""))).toEqual(['healthcheck.path']);
    expect(paths(valid.replace('keep_releases: 5', 'keep_releases: 1'))).toEqual(['keep_releases']);
    expect(paths(valid.replace('proxy: caddy', 'proxy: traefik'))).toEqual(['proxy']);
  });

  it('refuses paths that leave the upload or the app folder, and host volumes', () => {
    expect(isSafeRelative('.')).toBe(true);
    expect(isSafeRelative('apps/web')).toBe(true);
    for (const bad of ['/etc', '..', 'a/../../b', 'a\\b', '', 'a\0b']) expect(isSafeRelative(bad), bad).toBe(false);
    expect(paths(valid.replace('dir: .', 'dir: ../other'))).toEqual(['build.dir']);
    expect(paths(valid.replace('dir: .', 'dir: /srv'))).toEqual(['build.dir']);
    expect(paths(valid.replace('env_file: .env', 'env_file: ../site2/.env'))).toEqual(['run.env_file']);
    expect(paths(valid.replace('"uploads:/app/public/uploads"', '"/etc:/app/etc"'))).toEqual(['run.volumes.0']);
    expect(paths(valid.replace('"uploads:/app/public/uploads"', '"../x:/app"'))).toEqual(['run.volumes.0']);
    expect(paths(valid.replace('"uploads:/app/public/uploads"', '"data:/app/../etc"'))).toEqual(['run.volumes.0']);
    expect(paths(valid.replace('"uploads:/app/public/uploads"', '"data:/"'))).toEqual(['run.volumes.0']);
    expect(paths(valid.replace('tls: auto', 'tls: { cert: ../../proxy/key.pem, key: k.pem }'))).toEqual(['tls.cert']);
    const statics = 'name: site1\ndomains: [a.com]\nbuild: { type: static, output: ../../.env }\n';
    expect(paths(statics)).toEqual(['build.output']);
  });

  it('keeps options to the build types they belong to', () => {
    expect(paths(valid.replace('type: nextjs', 'type: dockerfile'))).toEqual(['build.node']);
    expect(paths(valid.replace('dir: .', 'dir: .\n  output: dist'))).toEqual(['build.output']);
    expect(paths(valid.replace('type: nextjs', 'type: rails'))).toEqual(['build.type']);
  });

  it('reports YAML problems: syntax, duplicate keys, aliases, non-mappings', () => {
    expect(paths('name: [unclosed\n')).toEqual(['']);
    expect(checkConfigText(`${valid}\nname: again\n`, 'site1').issues[0]!.message).toMatch(/unique/i);
    expect(paths('base: &b { type: static }\nname: site1\ndomains: [a.com]\nbuild: *b\n')).toContain('');
    expect(paths('- a\n- b\n')).toEqual(['']);
    expect(paths('x'.repeat(70 * 1024))).toEqual(['']);
  });

  it('lists every problem at once', () => {
    expect(paths('name: X\ndomains: [bad]\nbuild: { type: x }\nrun: { port: -1 }\n')).toEqual(['name', 'domains.0', 'build.type', 'run.port']);
  });
});

describe('domains across apps', () => {
  let root: string;
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('refuses a domain another app on the server already serves', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-config-'));
    const layout = new Layout(root);
    fs.mkdirSync(layout.app('blog'), { recursive: true });
    fs.writeFileSync(layout.config('blog'), 'name: blog\ndomains: [blog.site1.com, www.site1.com]\nbuild: { type: static }\n');
    // An invalid neighbour claims nothing
    fs.mkdirSync(layout.app('broken'), { recursive: true });
    fs.writeFileSync(layout.config('broken'), 'name: broken\ndomains: [site1.com]\nbuild: {}\n');

    expect(domainConflicts(layout, 'site1', ['site1.com', 'www.site1.com'])).toEqual([{ path: 'domains.1', message: 'www.site1.com is already used by app blog' }]);
    const result = validateForServer(layout, 'site1', valid);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ path: 'domains.1', message: 'www.site1.com is already used by app blog' }]);
    // The app's own config does not conflict with itself
    expect(validateForServer(layout, 'blog', fs.readFileSync(layout.config('blog'), 'utf8')).ok).toBe(true);
  });
});
