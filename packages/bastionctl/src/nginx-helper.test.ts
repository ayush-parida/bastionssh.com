import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The root helper for nginx mode (bastion-nginx.sh), run for real with
 * dash (or /bin/sh) against a temp tree: its fixed paths (conf.d, state, certbot's
 * live dir) are pointed into the tree and `nginx` and `certbot` are fakes
 * that log their arguments and fail on request. Under test: the server block
 * it generates, nginx -t + reload with the previous file restored on
 * failure, certbot certonly --webroot with the reload hook, that nothing in
 * the site file reaches nginx's config unchecked, that only
 * bastion-<app>.conf is ever touched, and the status it reports.
 */

const SCRIPT = path.join(import.meta.dirname, '..', 'bastion-nginx.sh');
/** dash where there is one: Debian and Ubuntu's /bin/sh, and stricter than most. */
const SHELL = fs.existsSync('/bin/dash') ? '/bin/dash' : '/bin/sh';
/** Self-signed, issuer O=Test Issuer, CN=T1 (see certs.test.ts). */
const PEM = `-----BEGIN CERTIFICATE-----
MIICKTCCAdACCQCVBp0hV8ARsjAKBggqhkjOPQQDAjAjMRQwEgYDVQQKDAtUZXN0
IElzc3VlcjELMAkGA1UEAwwCVDEwHhcNMjYxMDA1MTQzNjMwWhcNMjcwMTAzMTQz
NjMwWjAjMRQwEgYDVQQKDAtUZXN0IElzc3VlcjELMAkGA1UEAwwCVDEwggFLMIIB
AwYHKoZIzj0CATCB9wIBATAsBgcqhkjOPQEBAiEA/////wAAAAEAAAAAAAAAAAAA
AAD///////////////8wWwQg/////wAAAAEAAAAAAAAAAAAAAAD/////////////
//wEIFrGNdiqOpPns+u9VXaYhrxlHQawzFOw9jvOPD4n0mBLAxUAxJ02CIbnBJNq
ZnjhE50mt4GffpAEQQRrF9Hy4SxCR/i85uVjpEDydwN9gS3rM6D0oTlF2JjClk/j
QuL+Gn+bjufrSnwPnhYrzjNXazFezsu2QGg3v1H1AiEA/////wAAAAD/////////
/7zm+q2nF56E87nKwvxjJVECAQEDQgAEfKQmjLzDUDcNAn2EQyUYM/XE9KY9/rAl
RZFLRNIc1+9ynlVQgbCD1n71/R/eRSN2OMqkXOYZoh0b+R7MyWYLKzAKBggqhkjO
PQQDAgNHADBEAiAJzw9PwgUFpzzySpAjT6R8anqqBsIr/4Z5EV9dYLFIXAIgBFoB
bMlVlrHmDRiBPGOnA3aODPSa51qyNBX89trHEEo=
-----END CERTIFICATE-----
`;

let dir: string;
let conf: string;
let state: string;
let live: string;
let ctl: string;
let script: string;
let root: string;

function write(file: string, text: string, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-helper-')));
  conf = path.join(dir, 'etc/nginx/conf.d');
  state = path.join(dir, 'var/lib/bastion-nginx');
  live = path.join(dir, 'etc/letsencrypt/live');
  ctl = path.join(dir, 'ctl');
  root = path.join(dir, 'opt/bastion');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(conf, { recursive: true });
  fs.mkdirSync(ctl);
  // Someone else's site: must never be touched
  write(path.join(conf, 'default.conf'), 'server { listen 80 default_server; }\n');

  write(
    path.join(bin, 'nginx'),
    `#!/bin/sh
echo "nginx $*" >> ${ctl}/log
case "$1" in
  -t) if [ -f ${ctl}/fail-test ]; then echo "nginx: [emerg] unexpected end of file" >&2; exit 1; fi
      cat ${conf}/*.conf > ${ctl}/tested 2>/dev/null; cat ${ctl}/warn >&2 2>/dev/null; echo "nginx: configuration file test is successful" >&2 ;;
  -s) if [ -f ${ctl}/fail-reload ]; then echo "nginx: [error] reload failed" >&2; exit 1; fi ;;
  -T) echo "include ${conf}/*.conf;" ;;
esac
`,
    0o755,
  );
  write(
    path.join(bin, 'certbot'),
    `#!/bin/sh
echo "certbot $*" >> ${ctl}/log
if [ -f ${ctl}/fail-certbot ]; then echo "Some challenges have failed." >&2; echo "Domain: site1.com Type: unauthorized" >&2; exit 1; fi
name=; prev=
for a; do [ "$prev" = --cert-name ] && name=$a; prev=$a; done
case "$1" in
  certonly) if [ ! -f ${live}/$name/fullchain.pem ] || [ -f ${ctl}/renew ]; then
      mkdir -p ${live}/$name; echo "chain $(date +%s%N)" > ${live}/$name/fullchain.pem; echo key > ${live}/$name/privkey.pem; cp ${ctl}/cert.pem ${live}/$name/cert.pem
    fi ;;
  delete) rm -rf ${live}/$name ;;
esac
`,
    0o755,
  );
  write(path.join(ctl, 'cert.pem'), PEM);

  script = path.join(dir, 'bastion-nginx');
  const text = fs
    .readFileSync(SCRIPT, 'utf8')
    .replace(/^PATH=.*$/m, `PATH=${bin}:/usr/bin:/bin:/usr/sbin:/sbin`)
    .replace(/^CONF_DIR=.*$/m, `CONF_DIR=${conf}`)
    .replace(/^ALPINE_CONF_DIR=.*$/m, `ALPINE_CONF_DIR=${dir}/etc/nginx/http.d`)
    .replace(/^STATE_DIR=.*$/m, `STATE_DIR=${state}`)
    .replace(/^LIVE_DIR=.*$/m, `LIVE_DIR=${live}`)
    .replace(/^IPV6_PROBE=.*$/m, `IPV6_PROBE=${dir}/no-ipv6`)
    .replace(/^REQUIRE_ROOT=.*$/m, 'REQUIRE_ROOT=no');
  write(script, text, 0o755);
  site('app=site1\ntls=auto\nupstream=18480\ndomain=site1.com\ndomain=www.site1.com\n');
});

function site(text: string, app = 'site1') {
  write(path.join(root, 'proxy/nginx', `${app}.site`), text);
}

function helper(...args: string[]) {
  const r = spawnSync(SHELL, [script, ...args], { encoding: 'utf8' });
  const values: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) values[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { status: r.status, values, stderr: r.stderr };
}

const calls = () => (fs.existsSync(path.join(ctl, 'log')) ? fs.readFileSync(path.join(ctl, 'log'), 'utf8').trim().split('\n') : []);
const confFile = () => fs.readFileSync(path.join(conf, 'bastion-site1.conf'), 'utf8');

describe('bastion-nginx apply', () => {
  it('serves HTTP with the ACME webroot, gets the certificate, then serves HTTPS', () => {
    const r = helper('apply', root, 'site1');
    expect(r.values).toEqual({ result: 'applied', certificate: 'issued' });
    expect(r.status).toBe(0);
    expect(calls()).toEqual([
      'nginx -t',
      'nginx -s reload',
      `certbot certonly --webroot -w ${state}/acme --cert-name bastion-site1 --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring --expand --deploy-hook nginx -s reload -d site1.com -d www.site1.com`,
      'nginx -t',
      'nginx -s reload',
    ]);
    const text = confFile();
    expect(text).toContain('server_name site1.com www.site1.com;');
    expect(text).toContain(`location ^~ /.well-known/acme-challenge/ {\n\t\troot ${state}/acme;`);
    expect(text).toContain('return 301 https://$host$request_uri;');
    expect(text).toContain('\tlisten 443 ssl;');
    expect(text).toContain(`ssl_certificate ${live}/bastion-site1/fullchain.pem;`);
    expect(text).toContain(`ssl_certificate_key ${live}/bastion-site1/privkey.pem;`);
    expect(text).toContain('proxy_pass http://127.0.0.1:18480;');
    expect(text).toContain('proxy_set_header Host $host;');
    // nginx is the edge: what a client claims in X-Forwarded-For is not passed on (Caddy trusts nginx)
    expect(text).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(text).not.toContain('proxy_add_x_forwarded_for');
    expect(text).not.toContain('[::]');
    expect(fs.statSync(path.join(state, 'acme')).isDirectory()).toBe(true);
    // Nothing but bastion-site1.conf in conf.d changed
    expect(fs.readdirSync(conf).sort()).toEqual(['bastion-site1.conf', 'default.conf']);
    expect(fs.readFileSync(path.join(conf, 'default.conf'), 'utf8')).toBe('server { listen 80 default_server; }\n');
  });

  it('leaves nginx alone when nothing changed, and reports a renewed certificate', () => {
    helper('apply', root, 'site1');
    fs.rmSync(path.join(ctl, 'log'));
    expect(helper('apply', root, 'site1').values).toEqual({ result: 'unchanged', certificate: 'present' });
    expect(calls().filter((c) => c.startsWith('nginx'))).toEqual([]);
    write(path.join(ctl, 'renew'), '');
    expect(helper('apply', root, 'site1').values).toEqual({ result: 'unchanged', certificate: 'issued' });
  });

  it('puts the previous server block back when nginx -t refuses the new one', () => {
    helper('apply', root, 'site1');
    const before = confFile();
    site('app=site1\ntls=auto\nupstream=18480\ndomain=site1.com\n');
    write(path.join(ctl, 'fail-test'), '');
    const r = helper('apply', root, 'site1');
    expect(r.status).toBe(1);
    expect(r.values.error).toMatch(/^nginx -t refused the server block of site1; the previous one is back: .*unexpected end of file/);
    expect(confFile()).toBe(before);
    expect(fs.readdirSync(conf).sort()).toEqual(['bastion-site1.conf', 'default.conf']);
  });

  it('removes a new server block that fails to reload, and reloads the old config', () => {
    write(path.join(ctl, 'fail-reload'), '');
    const r = helper('apply', root, 'site1');
    expect(r.status).toBe(1);
    expect(r.values.error).toMatch(/^reloading nginx failed/);
    expect(fs.readdirSync(conf)).toEqual(['default.conf']);
  });

  it('refuses a domain another server block on the host already serves', () => {
    helper('apply', root, 'site1');
    const before = confFile();
    fs.rmSync(path.join(ctl, 'log'));
    // The admin's own site on the host serves shop.example.com: nginx -t passes with a warning
    site('app=site1\ntls=auto\nupstream=18480\ndomain=site1.com\ndomain=shop.example.com\n');
    write(path.join(ctl, 'warn'), 'nginx: [warn] conflicting server name "shop.example.com" on 0.0.0.0:80, ignored\n');
    const r = helper('apply', root, 'site1');
    expect(r.status).toBe(1);
    expect(r.values.error).toBe('shop.example.com is already served by another nginx server block on this host; the previous server block of site1 is back');
    expect(confFile()).toBe(before);
    // Neither reloaded nor sent to certbot
    expect(calls()).toEqual(['nginx -t']);
    // A conflict on a name that is not the app's own is not its business
    write(path.join(ctl, 'warn'), 'nginx: [warn] conflicting server name "www.shop.example.com" on 0.0.0.0:80, ignored\n');
    expect(helper('apply', root, 'site1').values.result).toBe('applied');
  });

  it('removes the server blocks of apps this root no longer serves, and only those', () => {
    site('app=blog\ntls=auto\nupstream=18480\ndomain=blog.io\n', 'blog');
    helper('apply', root, 'site1');
    helper('apply', root, 'blog');
    const blog = fs.readFileSync(path.join(conf, 'bastion-blog.conf'), 'utf8');
    // Generated from another deployments folder on this host, and one an administrator wrote
    write(path.join(conf, 'bastion-other.conf'), blog.replaceAll(root, '/srv/other').replaceAll('blog', 'other'));
    write(path.join(conf, 'bastion-mine.conf'), 'server { listen 80; server_name mine.io; }\n');
    // bastionctl removed blog's site file: deleted from a shell, or left out of the proxy
    fs.rmSync(path.join(root, 'proxy/nginx/blog.site'));
    fs.rmSync(path.join(ctl, 'log'));

    const r = helper('apply', root, 'site1');
    expect(r.values).toEqual({ result: 'unchanged', certificate: 'present' });
    expect(r.stderr).toContain(`nginx: removed the server block of blog, which ${root} no longer serves`);
    expect(fs.readdirSync(conf).sort()).toEqual(['bastion-mine.conf', 'bastion-other.conf', 'bastion-site1.conf', 'default.conf']);
    expect(calls().filter((c) => c.startsWith('nginx'))).toEqual(['nginx -t', 'nginx -s reload']);
    // Its certificate stays (remove deletes it)
    expect(fs.existsSync(path.join(live, 'bastion-blog/fullchain.pem'))).toBe(true);

    fs.rmSync(path.join(ctl, 'log'));
    helper('apply', root, 'site1');
    expect(calls().filter((c) => c.startsWith('nginx'))).toEqual([]);
  });

  it('puts stale server blocks back when nginx refuses the config without them', () => {
    site('app=blog\ntls=auto\nupstream=18480\ndomain=blog.io\n', 'blog');
    helper('apply', root, 'site1');
    helper('apply', root, 'blog');
    fs.rmSync(path.join(root, 'proxy/nginx/blog.site'));
    write(path.join(ctl, 'fail-test'), '');
    const r = helper('apply', root, 'site1');
    expect(r.stderr).toContain('warning: nginx refused the config without the stale server blocks of blog; they are back');
    expect(fs.readdirSync(conf).sort()).toEqual(['bastion-blog.conf', 'bastion-site1.conf', 'default.conf']);
  });

  it('takes over the lock of a run that was killed, and waits for one that is alive', () => {
    fs.mkdirSync(path.join(state, 'lock'), { recursive: true });
    // A pid that cannot be running
    fs.writeFileSync(path.join(state, 'lock', 'pid'), '999999999\n');
    const r = helper('apply', root, 'site1');
    expect(r.values.result).toBe('applied');
    expect(r.stderr).toContain('taking over the lock of run 999999999');
    expect(fs.existsSync(path.join(state, 'lock'))).toBe(false);
    // A live holder (this test's own process) is not taken over
    fs.mkdirSync(path.join(state, 'lock'));
    fs.writeFileSync(path.join(state, 'lock', 'pid'), `${process.pid}\n`);
    const started = Date.now();
    const waited = spawnSync(SHELL, ['-c', `(sleep 2; rm -rf ${state}/lock) & ${SHELL} ${script} apply ${root} site1; wait`], { encoding: 'utf8' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(waited.stdout).toContain('result=unchanged');
    expect(waited.stderr).not.toContain('taking over');
  }, 15_000);

  it('keeps serving HTTP when certbot fails, and remembers the error for status', () => {
    write(path.join(ctl, 'fail-certbot'), '');
    const r = helper('apply', root, 'site1');
    expect(r.status).toBe(1);
    expect(r.values).toMatchObject({ result: 'applied', certificate: 'failed' });
    expect(r.values.error).toContain('certbot: Some challenges have failed. Domain: site1.com Type: unauthorized');
    expect(confFile()).not.toContain('ssl_certificate');
    expect(confFile()).toContain('proxy_pass http://127.0.0.1:18480;');

    const s = helper('status', 'site1');
    expect(s.values).toMatchObject({ error_cert: 'bastion-site1', error_message: expect.stringContaining('Some challenges have failed') });
    expect(s.values.error_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

    // A later success clears it
    fs.rmSync(path.join(ctl, 'fail-certbot'));
    expect(helper('apply', root, 'site1').values).toEqual({ result: 'applied', certificate: 'issued' });
    expect(helper('status', 'site1').values).not.toHaveProperty('error_cert');
  });

  it('uses a separate staging certificate', () => {
    site('app=site1\ntls=staging\nupstream=18480\ndomain=site1.com\n');
    helper('apply', root, 'site1');
    expect(calls().find((c) => c.startsWith('certbot'))).toMatch(/--cert-name bastion-site1-staging .* --test-cert -d site1\.com$/);
    expect(confFile()).toContain(`ssl_certificate ${live}/bastion-site1-staging/fullchain.pem;`);
  });

  it('checks every value of the site file and its arguments before using any', () => {
    const refused: Array<[string, string]> = [
      ['app=site1\ntls=auto\nupstream=18480\ndomain=site1.com;include /etc/shadow\n', 'invalid domain'],
      ['app=site1\ntls=auto\nupstream=18480\ndomain=site1.com\nlisten=80\n', 'does not know'],
      ['app=other\ntls=auto\nupstream=18480\ndomain=site1.com\n', 'not for app site1'],
      ['app=site1\ntls=internal\nupstream=18480\ndomain=site1.com\n', 'tls must be auto or staging'],
      ['app=site1\ntls=auto\nupstream=80;\ndomain=site1.com\n', 'invalid upstream port'],
      ['app=site1\ntls=auto\nupstream=80\ndomain=site1.com\n', 'invalid upstream port'],
      ['app=site1\ntls=auto\nupstream=18480\n', '1 to 50 domains'],
      ['app=site1\ntls=auto\nupstream=18480\ndomain=10.0.0.1\n', 'invalid domain'],
      ['app=site1\ntls=auto\nupstream=18480\ndomain=-bad.com\n', 'invalid domain'],
      ['app=site1\ntls=auto\nupstream=18480\ndomain=*.site1.com\n', 'invalid domain'],
    ];
    for (const [text, error] of refused) {
      site(text);
      const r = helper('apply', root, 'site1');
      expect(r.status, text).toBe(1);
      expect(r.values.error, text).toContain(error);
    }
    expect(helper('apply', `${root}/../etc`, 'site1').values.error).toBe('invalid root directory');
    expect(helper('apply', 'relative', 'site1').values.error).toBe('invalid root directory');
    expect(helper('apply', root, '../x').values.error).toBe('invalid app name');
    expect(helper('apply', root, 'nope').values.error).toMatch(/nope\.site is missing/);
    expect(helper('remove', 'Site1').values.error).toBe('invalid app name');
    expect(helper('apply', root).values.error).toMatch(/^usage/);
    // A link in place of the site file is not followed
    fs.rmSync(path.join(root, 'proxy/nginx/site1.site'));
    fs.symlinkSync('/etc/hosts', path.join(root, 'proxy/nginx/site1.site'));
    expect(helper('apply', root, 'site1').values.error).toMatch(/site1\.site is missing/);
    expect(calls()).toEqual([]);
    expect(fs.readdirSync(conf)).toEqual(['default.conf']);
  });
});

describe('bastion-nginx remove, status and check', () => {
  it('removes the server block and certificates, and reports certificates with openssl', () => {
    helper('apply', root, 'site1');
    const s = helper('status', 'site1');
    expect(s.values).toMatchObject({ cert: 'bastion-site1', notBefore: 'Oct  5 14:36:30 2026 GMT', notAfter: 'Jan  3 14:36:30 2027 GMT', status: 'ok' });
    expect(s.values.issuer).toMatch(/O ?= ?Test Issuer.*CN ?= ?T1/);

    fs.rmSync(path.join(ctl, 'log'));
    expect(helper('remove', 'site1').values).toEqual({ result: 'removed', certificate: 'skipped' });
    expect(fs.readdirSync(conf)).toEqual(['default.conf']);
    expect(calls()).toEqual(['nginx -t', 'nginx -s reload', 'certbot delete --cert-name bastion-site1 --non-interactive']);
    expect(helper('status', 'site1').values).toEqual({ status: 'ok' });
    // Removing again is fine
    expect(helper('remove', 'site1').values.result).toBe('removed');
  });

  it('puts the server block back when nginx -t fails without it', () => {
    helper('apply', root, 'site1');
    write(path.join(ctl, 'fail-test'), '');
    expect(helper('remove', 'site1').values.error).toMatch(/^nginx -t failed without the server block of site1; it is back/);
    expect(fs.existsSync(path.join(conf, 'bastion-site1.conf'))).toBe(true);
  });

  it("writes into Alpine's http.d, which its nginx.conf includes inside http { } (conf.d is outside)", () => {
    const httpd = path.join(dir, 'etc/nginx/http.d');
    fs.mkdirSync(httpd);
    expect(helper('apply', root, 'site1').values.result).toBe('applied');
    expect(fs.readdirSync(httpd)).toEqual(['bastion-site1.conf']);
    expect(fs.readdirSync(conf)).toEqual(['default.conf']);
    expect(helper('remove', 'site1').values.result).toBe('removed');
    expect(fs.readdirSync(httpd)).toEqual([]);
  });

  it('keeps messages readable and on one line', () => {
    write(path.join(ctl, 'fail-certbot'), '');
    // Not [:print:]: BusyBox tr does not know the class and would blank out most letters
    expect(fs.readFileSync(SCRIPT, 'utf8')).not.toMatch(/tr -c '\[:/);
    expect(helper('apply', root, 'site1').values.error).toBe('certbot: Some challenges have failed. Domain: site1.com Type: unauthorized ');
  });

  it('reports what is installed', () => {
    expect(helper('check').values).toEqual({ version: '1', nginx: 'yes', certbot: 'yes', include: 'yes' });
  });
});
