import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CADDY_CERT_DIR, certs, issuerMatches, parseCaddyErrors, parseCertificate, sourceFor, storageName } from './certs.js';
import type { Ctx } from './context.js';
import { DockerApi } from './docker.js';
import { startFakeDocker, type FakeDocker } from './fake-docker.test-helper.js';
import { Layout, PROXY_CONTAINER } from './names.js';
import * as ops from './ops.js';

/**
 * Certificate facts from Caddy (deployments spec §6): the PEM Caddy stores
 * per issuer and domain, read inside the proxy container, and the TLS errors
 * Caddy logs — never a state, which BastionSSH derives on read.
 */

/** Self-signed, issuer O=Test Issuer, CN=T1; valid 2026-10-05T14:36:30Z to 2027-01-03T14:36:30Z. */
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
const INFO = { issuer: 'Test Issuer T1', notBefore: '2026-10-05T14:36:30.000Z', notAfter: '2027-01-03T14:36:30.000Z' };

describe('certificate parsing', () => {
  it('reads issuer and validity of the leaf, and nothing from junk', () => {
    expect(parseCertificate(PEM + PEM)).toEqual(INFO);
    expect(parseCertificate('not a certificate')).toBeNull();
    expect(parseCertificate('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n')).toBeNull();
  });

  it("maps domains and TLS settings onto Caddy's storage", () => {
    expect(storageName('*.site1.com')).toBe('wildcard_.site1.com');
    expect(storageName('site1.com')).toBe('site1.com');
    expect(sourceFor('auto')).toBe('acme');
    expect(sourceFor('dns:cloudflare')).toBe('acme');
    expect(sourceFor('staging')).toBe('staging');
    expect(sourceFor('internal')).toBe('internal');
    expect(sourceFor({ cert: 'c.pem', key: 'k.pem' })).toBe('files');
    expect(issuerMatches('acme', 'acme-v02.api.letsencrypt.org-directory')).toBe(true);
    expect(issuerMatches('acme', 'acme.zerossl.com-v2-dv90')).toBe(true);
    expect(issuerMatches('acme', 'acme-staging-v02.api.letsencrypt.org-directory')).toBe(false);
    expect(issuerMatches('staging', 'acme-staging-v02.api.letsencrypt.org-directory')).toBe(true);
    expect(issuerMatches('internal', 'local')).toBe(true);
    expect(issuerMatches('acme', 'local')).toBe(false);
  });

  it("keeps the latest TLS error Caddy logged per domain, ignoring other log lines", () => {
    const log = [
      '{"level":"info","ts":1790000000,"logger":"tls.obtain","msg":"acquiring lock","identifier":"site1.com"}',
      '{"level":"error","ts":1790000100,"logger":"tls.obtain","msg":"could not get certificate from issuer","identifier":"site1.com","error":"HTTP 400 urn:ietf:params:acme:error:connection"}',
      '{"level":"error","ts":1790000200,"logger":"tls.renew","msg":"will retry","identifier":"site1.com","error":"timeout\\nnext line"}',
      '{"level":"error","ts":1790000050,"logger":"tls.obtain","msg":"older","identifier":"site1.com"}',
      '{"level":"error","ts":1790000300,"logger":"http.log.access","msg":"handled","identifier":"site1.com"}',
      '{"level":"error","ts":1790000400,"logger":"tls.issuance.acme","msg":"challenge failed","identifiers":["www.site1.com"]}',
      'not json',
    ].join('\n');
    const errors = parseCaddyErrors(log);
    expect(errors.get('site1.com')).toEqual({ at: new Date(1790000200 * 1000).toISOString(), message: 'will retry: timeout next line' });
    expect(errors.get('www.site1.com')).toEqual({ at: new Date(1790000400 * 1000).toISOString(), message: 'challenge failed' });
    expect(errors.size).toBe(2);
  });
});

describe('certs command', () => {
  let fake: FakeDocker;
  let root: string;
  let layout: Layout;

  beforeAll(async () => {
    fake = await startFakeDocker();
  });
  afterAll(() => fake.close());

  const ctx = (): Ctx => ({ layout, docker: new DockerApi(fake.socket), log: () => {}, actor: 'ann', now: () => new Date('2026-10-06T00:00:00Z'), drainMs: 0, healthIntervalMs: 1 });

  async function app(config: string) {
    fs.writeFileSync(path.join(layout.tmp, 'site1.yml'), config);
    await ops.init(ctx(), 'site1', { config: 'tmp/site1.yml' });
  }

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-certs-')));
    layout = new Layout(root);
    fake.containers.clear();
    fake.execs.length = 0;
    fake.exec = () => ({ exitCode: 0 });
    await ops.setup(ctx());
  });

  it('reads the certificate of each domain from the issuer the config uses, inside the proxy container', async () => {
    await app('name: site1\ndomains: [site1.com, www.site1.com]\nbuild: { type: dockerfile }\n');
    const prod = `${CADDY_CERT_DIR}/acme-v02.api.letsencrypt.org-directory/site1.com/site1.com.crt`;
    const staging = `${CADDY_CERT_DIR}/acme-staging-v02.api.letsencrypt.org-directory/www.site1.com/www.site1.com.crt`;
    fake.exec = ({ cmd }) => {
      if (cmd[0] === 'find') return { exitCode: 0, stdout: `${prod}\n${staging}\n${CADDY_CERT_DIR}/acme-v02.api.letsencrypt.org-directory/site1.com/site1.com.json\n` };
      if (cmd[0] === 'cat' && cmd[1] === prod) return { exitCode: 0, stdout: PEM };
      return { exitCode: 1, stderr: 'no such file' };
    };
    const result = await certs(ctx(), 'site1');
    expect(result).toEqual([
      { domain: 'site1.com', source: 'acme', ...INFO, lastError: null },
      // Only a staging certificate exists, and the config asks for production ones
      { domain: 'www.site1.com', source: 'acme', issuer: null, notBefore: null, notAfter: null, lastError: null },
    ]);
    // argv only: find, then cat of the one matching file
    expect(fake.execs.filter((e) => e.container === PROXY_CONTAINER).map((e) => e.cmd)).toEqual([
      ['find', CADDY_CERT_DIR, '-type', 'f', '-name', '*.crt'],
      ['cat', prod],
    ]);
  });

  it('reads certificate files from the app folder for tls: { cert, key }', async () => {
    fs.mkdirSync(layout.app('site1'), { recursive: true });
    fs.writeFileSync(path.join(layout.app('site1'), 'cert.pem'), PEM);
    await app('name: site1\ndomains: [site1.com]\ntls: { cert: cert.pem, key: key.pem }\nbuild: { type: dockerfile }\n');
    expect(await certs(ctx(), 'site1')).toEqual([{ domain: 'site1.com', source: 'files', ...INFO, lastError: null }]);
  });

  it('points nginx mode at the host helper', async () => {
    fs.writeFileSync(path.join(layout.proxy, 'mode'), 'nginx\n');
    fs.mkdirSync(layout.app('site1'), { recursive: true });
    fs.writeFileSync(layout.config('site1'), 'name: site1\ndomains: [site1.com]\nbuild: { type: dockerfile }\nproxy: nginx\n');
    await expect(certs(ctx(), 'site1')).rejects.toThrow('sudo bastion-nginx status site1');
  });
});
