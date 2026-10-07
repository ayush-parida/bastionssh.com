import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BastionctlBundle } from './bundle.js';
import { DETECT_SCRIPT, detectNginx, helperCommand, nginxCertificates, nginxInstructions, NGINX_HELPER_PATH, opensslIssuer, parseHelperStatus, proxyState, runHelper } from './nginx.js';
import type { Remote, RunOptions, RunResult } from './remote.js';

/**
 * nginx mode from BastionSSH's side, over a scripted Remote: detecting the
 * host's nginx, the setup commands for what is missing, refusing a helper
 * that is not the shipped one, running it with sudo as quoted words only,
 * reading its answers (including certbot failures and sudo refusing), and
 * certificate facts from its status output.
 */

const HELPER = Buffer.from('#!/bin/sh\n# bastion-nginx as shipped\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const BUNDLE = { version: '9.9.9', script: Buffer.from(''), wrapper: Buffer.from(''), scriptSha256: '', wrapperSha256: '', nginxHelper: HELPER, nginxHelperSha256: sha(HELPER) } as BastionctlBundle;

interface Scripted {
  stdout?: string;
  stderr?: string[];
  exitCode?: number;
}

function remote(answer: (command: string) => Scripted, files: Record<string, Buffer> = { [NGINX_HELPER_PATH]: HELPER }) {
  const commands: string[] = [];
  const r: Remote = {
    server: { username: 'deploy' } as Remote['server'],
    async run(command: string, opts: RunOptions = {}): Promise<RunResult> {
      commands.push(command);
      const s = answer(command);
      for (const line of s.stderr ?? []) opts.onLine?.('stderr', line);
      return { exitCode: s.exitCode ?? 0, signal: null, timedOut: false, stdout: s.stdout ?? '', stderr: (s.stderr ?? []).join('\n'), durationMs: 1 };
    },
    async hashFile(path) {
      return files[path] ? sha(files[path]) : null;
    },
    async readFile(path) {
      return files[path] ?? null;
    },
    writeFile: async () => {},
    upload: async () => 0,
    remove: async () => {},
    download: async () => null,
    release: () => {},
  };
  return { r, commands };
}

const NGINX_HOST = 'installed=yes\nrunning=yes\nhttp=yes\nhttps=yes\ncertbot=yes\ninclude=yes\nsudo=yes\n';

describe('detecting the host nginx', () => {
  it('reads the constant probe and checks the installed helper against the shipped one', async () => {
    const { r, commands } = remote(() => ({ stdout: NGINX_HOST }));
    expect(await detectNginx(r, BUNDLE)).toEqual({
      detected: true,
      installed: true,
      running: true,
      ports: { http: true, https: true },
      certbot: true,
      confInclude: true,
      helper: 'ok',
      sudo: true,
    });
    expect(commands).toEqual([`'sh' '-c' '${DETECT_SCRIPT.replace(/'/g, `'\\''`)}'`]);

    const tampered = remote(() => ({ stdout: 'installed=yes\nrunning=no\nhttp=no\nhttps=no\n' }), { [NGINX_HELPER_PATH]: Buffer.from('#!/bin/sh\nrm -rf /\n') });
    expect(await detectNginx(tampered.r, BUNDLE)).toMatchObject({ detected: false, running: false, helper: 'mismatch', certbot: false, sudo: false });
  });

  it("finds a running nginx with BusyBox's pgrep too, which matches nginx's retitled processes", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-detect-'));
    try {
      // BusyBox: -x compares "nginx: master process nginx", so only -f finds it
      fs.writeFileSync(path.join(bin, 'pgrep'), `#!/bin/sh\n[ "$1" = -f ] && [ "$2" = '^nginx: master process' ]\n`, { mode: 0o755 });
      const r = spawnSync('/bin/sh', ['-c', DETECT_SCRIPT], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
      expect(r.stdout).toContain('running=yes\n');
      fs.writeFileSync(path.join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      expect(spawnSync('/bin/sh', ['-c', DETECT_SCRIPT], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } }).stdout).toContain('running=no\n');
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('lists the one-time commands for what is missing, nothing once ready', async () => {
    const missing = { detected: true, installed: true, running: true, ports: { http: true, https: true }, certbot: false, confInclude: false, helper: 'missing' as const, sudo: false };
    expect(nginxInstructions('/opt/bastion', 'deploy', missing)).toEqual([
      'sudo apt-get install -y certbot    # or your distribution’s certbot package (its timer renews certificates)',
      '# /etc/nginx/nginx.conf must include /etc/nginx/conf.d/*.conf (on Alpine /etc/nginx/http.d/*.conf) inside http { }: the server blocks are written there',
      "'sudo' 'install' '-o' 'root' '-g' 'root' '-m' '0755' '/opt/bastion/bin/bastion-nginx' '/usr/local/sbin/bastion-nginx'",
      "echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/bastion-nginx' | sudo tee /etc/sudoers.d/bastion-nginx && sudo chmod 0440 /etc/sudoers.d/bastion-nginx",
    ]);
    expect(nginxInstructions('/opt/bastion', 'deploy', { ...missing, certbot: true, confInclude: true, helper: 'ok', sudo: true })).toEqual([]);
  });

  it('shows instructions only for nginx mode, or before setup on a host nginx', async () => {
    const files = { [NGINX_HELPER_PATH]: HELPER, '/opt/bastion/proxy/mode': Buffer.from('caddy\n') };
    const caddy = remote(() => ({ stdout: NGINX_HOST.replace('sudo=yes', 'sudo=no') }), files);
    expect(await proxyState(caddy.r, '/opt/bastion', BUNDLE)).toMatchObject({ mode: 'caddy', instructions: [] });
    const fresh = remote(() => ({ stdout: NGINX_HOST.replace('sudo=yes', 'sudo=no') }));
    const state = await proxyState(fresh.r, null, BUNDLE);
    expect(state).toMatchObject({ mode: null, helperPath: NGINX_HELPER_PATH });
    expect(state.instructions).toHaveLength(1);
    expect(state.instructions[0]).toContain('/etc/sudoers.d/bastion-nginx');
  });
});

describe('running the helper', () => {
  it('runs sudo -n with quoted words and returns what it did, with its log', async () => {
    const lines: string[] = [];
    const { r, commands } = remote(() => ({ stdout: 'result=applied\ncertificate=issued\n', stderr: ['nginx: reloaded with the new server block of site1', 'certbot: bastion-site1 for site1.com'] }));
    expect(await runHelper(r, '/opt/bastion', 'site1', 'apply', BUNDLE, (l) => lines.push(l))).toEqual({
      app: 'site1',
      result: 'applied',
      certificate: 'issued',
      error: null,
      log: ['nginx: reloaded with the new server block of site1', 'certbot: bastion-site1 for site1.com'],
    });
    expect(lines).toHaveLength(2);
    expect(commands).toEqual(["'sudo' '-n' '/usr/local/sbin/bastion-nginx' 'apply' '/opt/bastion' 'site1'"]);
    await runHelper(r, '/opt/bastion', 'site1', 'remove', BUNDLE);
    expect(commands[1]).toBe(helperCommand(['remove', 'site1']));
  });

  it('reports a certbot failure with the server block still applied', async () => {
    const { r } = remote(() => ({ exitCode: 1, stdout: 'result=applied\ncertificate=failed\nerror=certbot: Some challenges have failed.\n' }));
    expect(await runHelper(r, '/opt/bastion', 'site1', 'apply', BUNDLE)).toMatchObject({ result: 'applied', certificate: 'failed', error: 'certbot: Some challenges have failed.' });
  });

  it('explains sudo asking for a password', async () => {
    const { r } = remote(() => ({ exitCode: 1, stderr: ['sudo: a password is required'] }));
    expect(await runHelper(r, '/opt/bastion', 'site1', 'apply', BUNDLE)).toMatchObject({
      result: 'failed',
      error: expect.stringContaining('sudo refused to run /usr/local/sbin/bastion-nginx without a password'),
    });
  });

  it('refuses a missing or modified helper, and invalid app names, before running anything', async () => {
    const missing = remote(() => ({}), {});
    await expect(runHelper(missing.r, '/opt/bastion', 'site1', 'apply', BUNDLE)).rejects.toMatchObject({ code: 'nginx_helper_missing', statusCode: 409 });
    const modified = remote(() => ({}), { [NGINX_HELPER_PATH]: Buffer.from('#!/bin/sh\n') });
    await expect(runHelper(modified.r, '/opt/bastion', 'site1', 'apply', BUNDLE)).rejects.toMatchObject({ code: 'nginx_helper_mismatch' });
    const ok = remote(() => ({}));
    await expect(runHelper(ok.r, '/opt/bastion', "x'; reboot", 'apply', BUNDLE)).rejects.toMatchObject({ statusCode: 400 });
    expect([...missing.commands, ...modified.commands, ...ok.commands]).toEqual([]);
  });
});

describe('certificates in nginx mode', () => {
  const STATUS = [
    'cert=bastion-site1',
    'issuer=C = US, O = Let\'s Encrypt, CN = R11',
    'notBefore=Oct  5 14:36:30 2026 GMT',
    'notAfter=Jan  3 14:36:30 2027 GMT',
    'cert=bastion-site1-staging',
    'issuer=C = US, O = (STAGING) Let\'s Encrypt, CN = (STAGING) Ersatz Edamame E1',
    'notBefore=Oct  1 00:00:00 2026 GMT',
    'notAfter=Dec 30 00:00:00 2026 GMT',
    'error_cert=bastion-site1-staging',
    'error_at=2026-10-05T12:00:00Z',
    'error_message=Some challenges have failed.',
    'status=ok',
  ].join('\n');

  it('picks the certificate the config uses, for every domain', () => {
    expect(parseHelperStatus(STATUS, 'site1', false, ['site1.com', 'www.site1.com'])).toEqual(
      ['site1.com', 'www.site1.com'].map((domain) => ({
        domain,
        source: 'certbot',
        issuer: "Let's Encrypt R11",
        notBefore: '2026-10-05T14:36:30.000Z',
        notAfter: '2027-01-03T14:36:30.000Z',
        lastError: null,
      })),
    );
    expect(parseHelperStatus(STATUS, 'site1', true, ['site1.com'])[0]).toMatchObject({
      issuer: "(STAGING) Let's Encrypt (STAGING) Ersatz Edamame E1",
      lastError: { at: '2026-10-05T12:00:00.000Z', message: 'Some challenges have failed.' },
    });
    expect(parseHelperStatus('status=ok\n', 'site1', false, ['site1.com'])[0]).toMatchObject({ issuer: null, notAfter: null, lastError: null });
  });

  it('reads both openssl issuer formats', () => {
    expect(opensslIssuer("issuer=C = US, O = Let's Encrypt, CN = R11")).toBe("Let's Encrypt R11");
    expect(opensslIssuer('issuer= /O=Test Issuer/CN=T1')).toBe('Test Issuer T1');
  });

  it('runs status through sudo', async () => {
    const { r, commands } = remote(() => ({ stdout: STATUS }));
    expect((await nginxCertificates(r, 'site1', false, ['site1.com'], BUNDLE))[0]!.issuer).toBe("Let's Encrypt R11");
    expect(commands).toEqual(["'sudo' '-n' '/usr/local/sbin/bastion-nginx' 'status' 'site1'"]);
  });
});
