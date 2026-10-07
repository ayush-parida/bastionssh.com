import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConfigText, domainConflicts, isDigestPinned, isDomain, isImageRef, isSafeRelative, publishConflicts, validateForServer } from './config.js';
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
      service: null,
      domains: ['site1.com', 'www.site1.com'],
      redirect_www: 'apex',
      tls: 'auto',
      build: { type: 'nextjs', node: '20', dir: '.', output: null, image: null },
      run: {
        port: 3000,
        env_file: '.env',
        volumes: [{ name: 'uploads', path: '/app/public/uploads', readonly: false, exclusive: false }],
        memory: '512m',
        cpus: 1,
        strategy: 'rolling',
        publish: { scope: 'none', port: null, target: null },
        command: null,
        entrypoint: null,
      },
      healthcheck: { type: 'http', path: '/', command: null, timeout: '30s' },
      keep_releases: 5,
      proxy: 'caddy',
      permissions: { deploy: 'operate' },
      backups: { schedule: 'off', keep: 7 },
    });
  });

  it('takes who may deploy: operate (the default) or manage', () => {
    expect(checkConfigText(`${valid}permissions: { deploy: manage }\n`, 'site1').config?.permissions).toEqual({ deploy: 'manage' });
    expect(checkConfigText(`${valid}permissions: {}\n`, 'site1').config?.permissions).toEqual({ deploy: 'operate' });
    expect(checkConfigText(`${valid}permissions: { deploy: admin }\n`, 'site1').issues).toEqual([{ path: 'permissions.deploy', message: 'Must be operate or manage' }]);
    expect(paths(`${valid}permissions: { deploy: manage, rollback: view }\n`)).toEqual(['permissions.rollback']);
    expect(paths(`${valid}permissions: manage\n`)).toEqual(['permissions']);
  });

  it('takes only Node.js versions it has a pinned build image for', () => {
    expect(checkConfigText(valid.replace("node: \"20\"", 'node: "22.11"'), 'site1').issues).toEqual([]);
    expect(paths(valid.replace("node: \"20\"", 'node: "16"'))).toEqual(['build.node']);
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
    // [] is a service only other apps reach; leaving the key out is a mistake
    expect(paths(valid.replace('[site1.com, www.site1.com]', '[]'))).toEqual([]);
    expect(paths(valid.replace('domains: [site1.com, www.site1.com]\n', ''))).toEqual(['domains']);
    expect(paths(valid.replace('[site1.com, www.site1.com]', 'site1.com'))).toEqual(['domains']);
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

const SERVICE = `
name: orders-db
service: postgres
build:
  type: image
  image: postgres:16.4@sha256:${'a'.repeat(64)}
run:
  port: 5432
  volumes: [{ name: data, path: /var/lib/postgresql/data, exclusive: true }]
  memory: 1g
  publish: none
healthcheck:
  type: command
  command: ["pg_isready", "-h", "127.0.0.1", "-U", "app"]
  timeout: 60s
domains: []
keep_releases: 3
`;

describe('services: build.type image, health check types, strategy, publish', () => {
  it('accepts the services spec example, with recreate forced by the exclusive volume', () => {
    const { config, issues } = checkConfigText(SERVICE, 'orders-db');
    expect(issues).toEqual([]);
    expect(config).toMatchObject({
      name: 'orders-db',
      service: 'postgres',
      domains: [],
      build: { type: 'image', image: `postgres:16.4@sha256:${'a'.repeat(64)}`, node: null, output: null },
      run: { port: 5432, volumes: [{ name: 'data', path: '/var/lib/postgresql/data', readonly: false, exclusive: true }], strategy: 'recreate', publish: { scope: 'none', port: null } },
      healthcheck: { type: 'command', command: ['pg_isready', '-h', '127.0.0.1', '-U', 'app'], timeout: '60s' },
      keep_releases: 3,
    });
  });

  it('takes image references with a tag or a digest only', () => {
    for (const ok of ['postgres:16', 'postgres:16.4-alpine', `postgres@sha256:${'b'.repeat(64)}`, 'valkey/valkey:8', 'ghcr.io/org/app:1.2.3', 'localhost:5000/team/db:v1', `minio/minio:RELEASE.2024-10-02T17-50-41Z@sha256:${'c'.repeat(64)}`]) {
      expect(isImageRef(ok), ok).toBe(true);
    }
    for (const bad of ['postgres', 'Postgres:16', 'postgres:', 'postgres:16 --privileged', '-postgres:16', 'postgres:16@sha256:short', 'localhost:5000/db', 'a/../b:1', `x:${'1'.repeat(200)}`]) {
      expect(isImageRef(bad), bad).toBe(false);
    }
    expect(isDigestPinned(`postgres:16@sha256:${'d'.repeat(64)}`)).toBe(true);
    expect(isDigestPinned('postgres:16')).toBe(false);
    const image = (ref: string) => paths(SERVICE.replace(/image: .*\n/, `image: "${ref}"\n`), 'orders-db');
    expect(image('postgres')).toEqual(['build.image']);
    expect(image('postgres:16')).toEqual([]);
    expect(paths(SERVICE.replace(/ {2}image: .*\n/, ''), 'orders-db')).toEqual(['build.image']);
    // Nothing is built from an upload: no build options, and image only with type image
    expect(paths(SERVICE.replace('type: image', 'type: image\n  dir: app'), 'orders-db')).toEqual(['build.dir']);
    expect(paths(SERVICE.replace('type: image', 'type: image\n  node: "20"'), 'orders-db')).toEqual(['build.node']);
    expect(paths(valid.replace('type: nextjs', 'type: nextjs\n  image: postgres:16'))).toEqual(['build.image']);
  });

  it('checks the service template id', () => {
    expect(paths(SERVICE.replace('service: postgres', 'service: Postgres!'), 'orders-db')).toEqual(['service']);
    expect(checkConfigText(valid, 'site1').config?.service).toBeNull();
  });

  it('takes http, tcp and command health checks, each with only its own options', () => {
    const hc = (text: string) => checkConfigText(valid.replace('healthcheck: { path: /, timeout: 30s }', text), 'site1');
    expect(hc('healthcheck: { type: tcp }').config?.healthcheck).toEqual({ type: 'tcp', path: '/', command: null, timeout: '30s' });
    expect(hc('healthcheck: { type: http, path: /up }').config?.healthcheck).toMatchObject({ type: 'http', path: '/up' });
    // The type follows from what is given
    expect(hc('healthcheck: { command: [redis-cli, ping] }').config?.healthcheck).toMatchObject({ type: 'command', command: ['redis-cli', 'ping'] });
    expect(hc('healthcheck: { type: grpc }').issues.map((i) => i.path)).toEqual(['healthcheck.type']);
    expect(hc('healthcheck: { type: tcp, path: /up }').issues.map((i) => i.path)).toEqual(['healthcheck.path']);
    expect(hc('healthcheck: { type: http, command: [x] }').issues.map((i) => i.path)).toEqual(['healthcheck.command']);
    expect(hc('healthcheck: { type: command }').issues.map((i) => i.path)).toEqual(['healthcheck.command']);
    for (const bad of ['[]', '"pg_isready -U app"', '[pg_isready, 5]', '[""]', `[${Array(65).fill('x').join(', ')}]`, '["a\\nb"]']) {
      expect(hc(`healthcheck: { type: command, command: ${bad} }`).issues.map((i) => i.path), bad).toEqual(['healthcheck.command']);
    }
    // Without domains the default is a TCP connect (nothing answers HTTP on a database)
    expect(checkConfigText(SERVICE.replace(/healthcheck:\n( {2}.*\n)+/, ''), 'orders-db').config?.healthcheck.type).toBe('tcp');
    expect(checkConfigText(valid, 'site1').config?.healthcheck.type).toBe('http');
  });

  it('takes run.strategy, forcing recreate for an exclusive volume or a published port', () => {
    const run = (extra: string) => checkConfigText(valid.replace('  cpus: 1', `  cpus: 1\n${extra}`), 'site1');
    expect(run('  strategy: recreate').config?.run.strategy).toBe('recreate');
    expect(run('  strategy: rolling').config?.run.strategy).toBe('rolling');
    expect(run('  strategy: blue-green').issues.map((i) => i.path)).toEqual(['run.strategy']);
    expect(paths(SERVICE.replace('  publish: none', '  publish: none\n  strategy: rolling'), 'orders-db')).toEqual(['run.strategy']);
    expect(run('  publish: localhost:8080').config?.run.strategy).toBe('recreate');
    expect(run('  publish: localhost:8080\n  strategy: rolling').issues).toEqual([{ path: 'run.strategy', message: 'Must be recreate: run.publish binds a host port (two containers cannot use it at once)' }]);
  });

  it('takes the long volume form, strictly', () => {
    const vol = (v: string) => checkConfigText(valid.replace('["uploads:/app/public/uploads"]', v), 'site1');
    expect(vol('[{ name: data, path: /data }, "cache:/cache:ro"]').config?.run.volumes).toEqual([
      { name: 'data', path: '/data', readonly: false, exclusive: false },
      { name: 'cache', path: '/cache', readonly: true, exclusive: false },
    ]);
    expect(vol('[{ name: data, path: /data, readonly: true }]').config?.run.volumes[0]?.readonly).toBe(true);
    expect(vol('[{ name: data, path: /data, exclusive: yes }]').issues.map((i) => i.path)).toEqual(['run.volumes.0.exclusive']);
    expect(vol('[{ name: data, path: /data, driver: nfs }]').issues.map((i) => i.path)).toEqual(['run.volumes.0.driver']);
    expect(vol('[{ name: /etc, path: /data }]').issues.map((i) => i.path)).toEqual(['run.volumes.0.name']);
    expect(vol('[{ name: data, path: data }]').issues.map((i) => i.path)).toEqual(['run.volumes.0.path']);
    expect(vol('[{ name: data, path: /a/../b }]').issues.map((i) => i.path)).toEqual(['run.volumes.0']);
    expect(vol('[{ name: data, path: /a }, "data:/b"]').issues.map((i) => i.path)).toEqual(['run.volumes.1']);
    expect(vol('[42]').issues.map((i) => i.path)).toEqual(['run.volumes.0']);
  });

  it('takes run.publish: none, localhost:<port> or public:<port>, never the proxy’s ports', () => {
    const pub = (v: string) => checkConfigText(valid.replace('  cpus: 1', `  cpus: 1\n  publish: ${v}`), 'site1');
    expect(pub('none').config?.run.publish).toEqual({ scope: 'none', port: null, target: null });
    expect(pub('localhost:15432').config?.run.publish).toEqual({ scope: 'localhost', port: 15432, target: null });
    expect(pub('public:9000').config?.run.publish).toEqual({ scope: 'public', port: 9000, target: null });
    // Another port of the container than run.port (MinIO's S3 API beside the console the domain serves)
    expect(pub('public:19000:9000').config?.run.publish).toEqual({ scope: 'public', port: 19000, target: 9000 });
    for (const bad of ['yes', '9000', 'everywhere:9000', 'public:0', 'public:70000', 'public:80', 'localhost:443', 'public:9000:0', 'public:9000:70000', 'public:1:2:3']) {
      expect(pub(bad).issues.map((i) => i.path), bad).toEqual(['run.publish']);
    }
  });

  it('takes run.command and run.entrypoint as argument lists', () => {
    const run = (extra: string) => checkConfigText(valid.replace('  cpus: 1', `  cpus: 1\n${extra}`), 'site1');
    expect(run('  command: [server, /data, --console-address, ":9001"]').config?.run.command).toEqual(['server', '/data', '--console-address', ':9001']);
    expect(run('  entrypoint: [/bin/sh, -c]\n  command: ["exec /mailpit"]').config?.run).toMatchObject({ entrypoint: ['/bin/sh', '-c'], command: ['exec /mailpit'] });
    for (const bad of ['[]', '"server /data"', '[1, 2]', `[${Array(65).fill('x').join(', ')}]`]) {
      expect(run(`  command: ${bad}`).issues.map((i) => i.path), bad).toEqual(['run.command']);
      expect(run(`  entrypoint: ${bad}`).issues.map((i) => i.path), bad).toEqual(['run.entrypoint']);
    }
  });

  it('takes backups for quick services with a backup command', () => {
    const b = (text: string) => checkConfigText(`${SERVICE}${text}\n`, 'orders-db');
    expect(b('backups: { schedule: daily, keep: 14 }').config?.backups).toEqual({ schedule: 'daily', keep: 14 });
    expect(b('backups: { schedule: hourly }').config?.backups).toEqual({ schedule: 'hourly', keep: 7 });
    expect(b('backups: { schedule: weekly }').issues.map((i) => i.path)).toEqual(['backups.schedule']);
    expect(b('backups: { keep: 0 }').issues.map((i) => i.path)).toEqual(['backups.keep']);
    expect(b('backups: { at: "03:00" }').issues.map((i) => i.path)).toEqual(['backups.at']);
    // An app, or a template with nothing to dump, has no schedule to run
    expect(checkConfigText(`${valid}backups: { schedule: daily }\n`, 'site1').issues.map((i) => i.path)).toEqual(['backups.schedule']);
    expect(paths(`${SERVICE.replace('service: postgres', 'service: memcached')}backups: { schedule: daily }\n`, 'orders-db')).toEqual(['backups.schedule']);
    // Off, any app may say so
    expect(checkConfigText(`${valid}backups: { schedule: "off" }\n`, 'site1').issues).toEqual([]);
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

describe('published ports across apps', () => {
  let root: string;
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('refuses a host port another app on the server publishes', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-config-'));
    const layout = new Layout(root);
    fs.mkdirSync(layout.app('cache'), { recursive: true });
    fs.writeFileSync(layout.config('cache'), 'name: cache\ndomains: []\nbuild: { type: image, image: "redis:7" }\nrun: { port: 6379, publish: "localhost:16379" }\n');
    expect(publishConflicts(layout, 'db', { scope: 'public', port: 16379 })).toEqual([{ path: 'run.publish', message: 'Host port 16379 is already published by app cache' }]);
    expect(publishConflicts(layout, 'db', { scope: 'public', port: 16380 })).toEqual([]);
    expect(publishConflicts(layout, 'cache', { scope: 'localhost', port: 16379 })).toEqual([]);
    const db = SERVICE.replace('publish: none', 'publish: "localhost:16379"');
    expect(validateForServer(layout, 'orders-db', db).errors).toEqual([{ path: 'run.publish', message: 'Host port 16379 is already published by app cache' }]);
    // Without domains, the proxy mode it names does not matter
    expect(validateForServer(layout, 'orders-db', `${SERVICE}proxy: nginx\n`).ok).toBe(true);
  });
});
