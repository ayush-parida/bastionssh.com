import { describe, expect, it } from 'vitest';
import { codedError, fakeConnect, fakeDeps } from '../diagnostics/fakes.test-helper.js';
import { checkDomainDns, checkPorts, domainsReport, PUBLIC_IP_SCRIPT, serverAddresses, wantedRecords, withState, type DomainDeps } from './domains.js';
import type { RunResult } from './remote.js';

/**
 * Domain pre-checks (deployments spec §6) with DNS and sockets replaced:
 * the server's public address (its own, its name resolved, or asked from the
 * server), each domain's records against it with the exact record to
 * create, ports 80/443 through the diagnostics TCP probe, and certificate
 * state derived from the facts the server reports.
 */

const SERVER = '203.0.113.10';

type Records = Record<string, { A?: string[]; AAAA?: string[]; error?: string }>;

function deps(records: Records, connect = fakeConnect({ kind: 'connect' }).connect): DomainDeps {
  return {
    async resolve(name, type) {
      const entry = records[name];
      if (!entry) throw codedError('ENOTFOUND');
      if (entry.error) throw codedError(entry.error);
      const list = entry[type];
      if (!list || list.length === 0) throw codedError('ENODATA');
      return list;
    },
    diagnostics: fakeDeps({ connect, lookup: async () => [{ address: SERVER, family: 4 }] }),
  };
}

const result = (stdout: string): RunResult => ({ exitCode: 0, signal: null, timedOut: false, stdout, stderr: '', durationMs: 1 });

describe('DNS against the server', () => {
  it('is ok when every address is the server’s', async () => {
    expect(await checkDomainDns('site1.com', [SERVER], deps({ 'site1.com': { A: [SERVER] } }))).toEqual({
      status: 'ok',
      addresses: [SERVER],
      detail: `site1.com points at this server (${SERVER}).`,
      records: [],
    });
  });

  it('names the exact record to create when the domain has none, or does not exist', async () => {
    const none = await checkDomainDns('www.site1.com', [SERVER], deps({ 'www.site1.com': {} }));
    expect(none).toMatchObject({ status: 'missing', records: [{ type: 'A', name: 'www.site1.com', value: SERVER }] });
    expect(none.detail).toMatch(/^www\.site1\.com has no A or AAAA record\. Create the record below/);
    const nx = await checkDomainDns('new.site1.com', [SERVER, '2001:db8::10'], deps({}));
    expect(nx.status).toBe('missing');
    expect(nx.detail).toMatch(/does not exist in DNS \(NXDOMAIN\)/);
    expect(nx.records).toEqual([
      { type: 'A', name: 'new.site1.com', value: SERVER },
      { type: 'AAAA', name: 'new.site1.com', value: '2001:db8::10' },
    ]);
  });

  it('flags a domain pointing elsewhere, and a stray AAAA record the server has no address for', async () => {
    const wrong = await checkDomainDns('site1.com', [SERVER], deps({ 'site1.com': { A: ['198.51.100.7'] } }));
    expect(wrong).toMatchObject({ status: 'wrong', addresses: ['198.51.100.7'], records: [{ type: 'A', name: 'site1.com', value: SERVER }] });
    expect(wrong.detail).toContain(`site1.com points at 198.51.100.7, not this server (${SERVER}).`);

    const stray = await checkDomainDns('site1.com', [SERVER], deps({ 'site1.com': { A: [SERVER], AAAA: ['2001:db8::99'] } }));
    expect(stray).toMatchObject({ status: 'wrong', records: [] });
    expect(stray.detail).toContain('Delete the AAAA record (2001:db8::99)');
  });

  it('checks a wildcard through a name under it, and asks for the * record', async () => {
    const r = await checkDomainDns('*.apps.io', [SERVER], deps({ 'bastion-dns-check.apps.io': { A: [SERVER] } }));
    expect(r.status).toBe('ok');
    expect(wantedRecords('*.apps.io', [SERVER])).toEqual([{ type: 'A', name: '*.apps.io', value: SERVER }]);
  });

  it('reports lookup failures and an unknown server address', async () => {
    const failed = await checkDomainDns('site1.com', [SERVER], deps({ 'site1.com': { error: 'ESERVFAIL' } }));
    expect(failed).toMatchObject({ status: 'error', detail: 'DNS lookup for site1.com failed: The nameserver failed to answer (SERVFAIL)' });
    expect((await checkDomainDns('site1.com', [], deps({ 'site1.com': { A: [SERVER] } }))).status).toBe('skipped');
  });
});

describe("the server's public address", () => {
  const noRun = { run: async () => { throw new Error('the server should not be asked'); } };

  it('is the server’s address in BastionSSH when that is public, else its name resolved', async () => {
    expect(await serverAddresses({ host: SERVER }, noRun, deps({}))).toEqual({ addresses: [SERVER], source: 'host' });
    expect(await serverAddresses({ host: 'web-1.example.com' }, noRun, deps({}))).toEqual({ addresses: [SERVER], source: 'dns' });
  });

  it('is asked from the server when BastionSSH reaches it on a private address, with the echo services as arguments', async () => {
    const commands: string[] = [];
    const remote = { run: async (command: string) => (commands.push(command), result('ip=198.51.100.20\n')) };
    expect(await serverAddresses({ host: '10.0.0.5' }, remote, deps({}))).toEqual({ addresses: ['198.51.100.20'], source: 'server' });
    expect(commands[0]).toMatch(new RegExp(`^'sh' '-c' '${PUBLIC_IP_SCRIPT.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(commands[0]).toContain("'sh' 'https://");
    // A private or garbled answer is no address
    const priv = { run: async () => result('ip=192.168.1.4\n') };
    expect(await serverAddresses({ host: '10.0.0.5' }, priv, deps({}))).toEqual({ addresses: [], source: 'none' });
  });
});

describe('ports 80 and 443', () => {
  it('answers open, closed or filtered with what to do', async () => {
    expect((await checkPorts(SERVER, deps({}))).map((p) => [p.port, p.status])).toEqual([
      [80, 'open'],
      [443, 'open'],
    ]);
    const closed = await checkPorts(SERVER, deps({}, fakeConnect({ kind: 'error', code: 'ECONNREFUSED' }).connect));
    expect(closed[0]).toMatchObject({ port: 80, status: 'closed', remediation: expect.stringContaining('Nothing accepts connections on port 80') });
    const filtered = await checkPorts(SERVER, deps({}, fakeConnect({ kind: 'error', code: 'ETIMEDOUT' }).connect));
    expect(filtered[1]).toMatchObject({ port: 443, status: 'filtered', remediation: expect.stringContaining('Allow inbound TCP 443 from anywhere') });
  });
});

describe('the report', () => {
  const now = Date.parse('2026-10-06T00:00:00Z');
  const facts = { source: 'acme' as const, issuer: "Let's Encrypt R11", notBefore: '2026-10-01T00:00:00.000Z', notAfter: '2026-12-30T00:00:00.000Z', lastError: null };

  it('puts DNS, ports and certificates (state derived now) together', async () => {
    const report = await domainsReport({
      app: 'site1',
      config: { domains: ['site1.com', 'www.site1.com'], tls: 'auto' },
      proxy: 'caddy',
      server: { host: SERVER },
      remote: { run: async () => result('') },
      certificates: async () => [{ domain: 'site1.com', ...facts }],
      deps: deps({ 'site1.com': { A: [SERVER] } }),
      now,
    });
    expect(report).toMatchObject({ app: 'site1', proxy: 'caddy', tls: 'auto', serverAddresses: [SERVER], addressSource: 'host', certificatesError: null, checkedAt: '2026-10-06T00:00:00.000Z' });
    expect(report.domains[0]).toMatchObject({ domain: 'site1.com', dns: { status: 'ok' }, certificate: { state: 'valid', daysLeft: 85 } });
    expect(report.domains[1]).toMatchObject({ domain: 'www.site1.com', dns: { status: 'missing' }, certificate: null });
    expect(report.ports.map((p) => p.status)).toEqual(['open', 'open']);
  });

  it('skips the port check for certificates that need no ACME challenge, and reports unreadable certificates', async () => {
    const report = await domainsReport({
      app: 'site1',
      config: { domains: ['site1.internal'], tls: 'internal' },
      proxy: 'caddy',
      server: { host: SERVER },
      remote: { run: async () => result('') },
      certificates: async () => {
        throw new Error('The proxy is not running on this server (run bastionctl setup)');
      },
      deps: deps({}),
      now,
    });
    expect(report.ports).toEqual([]);
    expect(report.certificatesError).toBe('The proxy is not running on this server (run bastionctl setup)');
  });

  it('derives failing from a renewal that is overdue or erroring, and expired after the end', () => {
    const at = (iso: string) => Date.parse(iso);
    const [valid] = withState([{ domain: 'a.com', ...facts }], at('2026-10-06T00:00:00Z'));
    expect(valid!.state).toBe('valid');
    // Renewal is due 30 days before the end; two days later it is failing
    expect(withState([{ domain: 'a.com', ...facts }], at('2026-12-01T00:00:00Z'))[0]!.state).toBe('valid');
    expect(withState([{ domain: 'a.com', ...facts }], at('2026-12-03T00:00:00Z'))[0]!.state).toBe('failing');
    // In the renewal window with an error logged after issuance: failing at once
    const erroring = { domain: 'a.com', ...facts, lastError: { at: '2026-11-30T12:00:00.000Z', message: 'timeout' } };
    expect(withState([erroring], at('2026-12-01T00:00:00Z'))[0]!.state).toBe('failing');
    // The same error before the window is old news
    expect(withState([erroring], at('2026-11-01T00:00:00Z'))[0]!.state).toBe('valid');
    expect(withState([{ domain: 'a.com', ...facts }], at('2027-01-01T00:00:00Z'))[0]).toMatchObject({ state: 'expired', daysLeft: -2 });
    // None yet: missing while issuance is pending, failing once it errored
    const none = { domain: 'a.com', source: 'acme' as const, issuer: null, notBefore: null, notAfter: null, lastError: null };
    expect(withState([none])[0]!.state).toBe('missing');
    expect(withState([{ ...none, lastError: { at: null, message: 'NXDOMAIN' } }])[0]!.state).toBe('failing');
    // Files are nobody's to renew: they only expire
    expect(withState([{ domain: 'a.com', ...facts, source: 'files' }], at('2026-12-03T00:00:00Z'))[0]!.state).toBe('valid');
    expect(withState([{ domain: 'a.com', ...facts, source: 'files' }], at('2026-12-20T00:00:00Z'))[0]!.state).toBe('expiring');
  });
});
