import { isIP } from 'node:net';
import {
  deployCertState,
  type DeployAppConfig,
  type DeployCertFacts,
  type DeployCertificate,
  type DeployDnsRecord,
  type DeployDomainDns,
  type DeployDomainsReport,
  type DeployPortCheck,
  type DeployProxyMode,
} from '@smt/shared';
import { config, DEFAULT_EGRESS_IP_SERVICES } from '../config/index.js';
import { isPublicAddress } from '../dns/domain.js';
import { describeDnsError, isEmptyAnswer, isNotFound } from '../dns/errors.js';
import { createResolver } from '../dns/records.js';
import { awsRuleType } from '../diagnostics/remediation.js';
import { checkDns, checkTcp, defaultDeps, type DiagnosticsDeps } from '../diagnostics/steps.js';
import { shellCommand } from '../docker/shell.js';
import { parseKeyValues } from './install.js';
import type { Remote, ServerRow } from './remote.js';

/**
 * Domain pre-checks (deployments spec §6), run on read and never stored:
 *
 * - DNS: each domain's A/AAAA records (the DNS module's resolver) against the
 *   server's public address, with the exact record to create when they do
 *   not match. A domain is saved either way; this only tells people why a
 *   certificate cannot be issued yet.
 * - Ports 80 and 443 (the diagnostics TCP probe) from BastionSSH, when the
 *   certificates come from an ACME CA that must reach the server: tls auto or
 *   staging. A port BastionSSH reaches may still be closed to the internet,
 *   and the other way round behind a VPN; the result says what it saw.
 * - Certificates: facts read from the server, with the state derived here.
 *
 * The server's public address is its address in BastionSSH when that is
 * public, else its host name resolved, else what the server itself reports
 * through an IP echo service (a server reached over a VPN).
 */

export interface DomainDeps {
  /** A or AAAA addresses of a name; throws `node:dns` errors. */
  resolve(name: string, type: 'A' | 'AAAA'): Promise<string[]>;
  diagnostics: DiagnosticsDeps;
}

export const defaultDomainDeps: DomainDeps = {
  resolve: (name, type) => (type === 'A' ? createResolver().resolve4(name) : createResolver().resolve6(name)),
  diagnostics: defaultDeps,
};

/** Asks each echo service in turn, from the server; prints `ip=<address>`. Constant: the URLs are arguments. */
export const PUBLIC_IP_SCRIPT = [
  'for u in "$@"; do',
  '  ip=$(curl -fsS --max-time 5 "$u" 2>/dev/null || wget -qO- -T 5 "$u" 2>/dev/null) || continue',
  '  case $ip in *[!0-9a-fA-F.:]* | "") continue ;; esac',
  '  printf "ip=%s\\n" "$ip"',
  '  exit 0',
  'done',
].join('\n');

export interface ServerAddresses {
  addresses: string[];
  source: DeployDomainsReport['addressSource'];
}

export async function serverAddresses(server: Pick<ServerRow, 'host'>, remote: Pick<Remote, 'run'>, deps: DomainDeps = defaultDomainDeps): Promise<ServerAddresses> {
  const host = server.host.trim();
  if (isIP(host)) {
    if (isPublicAddress(host)) return { addresses: [host], source: 'host' };
  } else {
    const resolved = (await checkDns(host, deps.diagnostics)).addresses.filter(isPublicAddress);
    if (resolved.length > 0) return { addresses: resolved, source: 'dns' };
  }
  const services = config.egressIp.mode === 'lookup' ? config.egressIp.services : DEFAULT_EGRESS_IP_SERVICES;
  try {
    const result = await remote.run(shellCommand(['sh', '-c', PUBLIC_IP_SCRIPT, 'sh', ...services]), { timeoutMs: 25_000 });
    const ip = parseKeyValues(result.stdout).ip?.trim();
    if (ip && isIP(ip) && isPublicAddress(ip)) return { addresses: [ip], source: 'server' };
  } catch {
    // reported as no address
  }
  return { addresses: [], source: 'none' };
}

async function lookup(name: string, type: 'A' | 'AAAA', deps: DomainDeps): Promise<{ addresses: string[]; notFound: boolean; error: string | null }> {
  try {
    return { addresses: await deps.resolve(name, type), notFound: false, error: null };
  } catch (err) {
    if (isEmptyAnswer(err)) return { addresses: [], notFound: false, error: null };
    if (isNotFound(err)) return { addresses: [], notFound: true, error: null };
    return { addresses: [], notFound: false, error: describeDnsError(err) };
  }
}

/** The records `domain` needs to point at `server` (wildcards: the `*` record itself). */
export function wantedRecords(domain: string, server: readonly string[]): DeployDnsRecord[] {
  return server.map((value) => ({ type: isIP(value) === 6 ? 'AAAA' : 'A', name: domain, value }));
}

/**
 * Whether `domain` points at the server. A wildcard is checked through a
 * name under it. Every address it resolves to must be the server's: an
 * extra AAAA record pointing elsewhere sends IPv6 visitors (and Let's
 * Encrypt, which prefers IPv6) to another machine.
 */
export async function checkDomainDns(domain: string, server: readonly string[], deps: DomainDeps = defaultDomainDeps): Promise<DeployDomainDns> {
  const probe = domain.startsWith('*.') ? `bastion-dns-check.${domain.slice(2)}` : domain;
  const [a, aaaa] = await Promise.all([lookup(probe, 'A', deps), lookup(probe, 'AAAA', deps)]);
  const addresses = [...a.addresses, ...aaaa.addresses];
  const want = wantedRecords(domain, server);

  if (server.length === 0) {
    return {
      status: 'skipped',
      addresses,
      detail: 'The server’s public address could not be determined, so DNS was not compared. Point the domain at the address visitors reach the server on.',
      records: [],
    };
  }
  if (addresses.length === 0 && (a.error || aaaa.error) && !a.notFound && !aaaa.notFound) {
    return { status: 'error', addresses, detail: `DNS lookup for ${probe} failed: ${a.error ?? aaaa.error}`, records: want };
  }
  if (addresses.length === 0) {
    const why = a.notFound || aaaa.notFound ? `${probe} does not exist in DNS (NXDOMAIN).` : `${probe} has no A or AAAA record.`;
    return { status: 'missing', addresses, detail: `${why} Create the record${want.length === 1 ? '' : 's'} below at your DNS provider.`, records: want };
  }
  const elsewhere = addresses.filter((ip) => !server.includes(ip));
  if (elsewhere.length === 0) return { status: 'ok', addresses, detail: `${domain} points at this server (${addresses.join(', ')}).`, records: [] };

  // What to create or change: the server's addresses not yet listed
  const records = want.filter((r) => !addresses.includes(r.value));
  const strayV6 = aaaa.addresses.filter((ip) => !server.includes(ip));
  const notes = [`${domain} points at ${elsewhere.join(', ')}, not this server (${server.join(', ')}).`];
  if (records.length > 0) notes.push(`Set the record${records.length === 1 ? '' : 's'} below at your DNS provider, replacing the old value${elsewhere.length === 1 ? '' : 's'}.`);
  if (strayV6.length > 0 && !server.some((ip) => isIP(ip) === 6)) notes.push(`Delete the AAAA record (${strayV6.join(', ')}): this server has no public IPv6 address here.`);
  return { status: 'wrong', addresses, detail: notes.join(' '), records };
}

function portRemediation(port: 80 | 443, kind: 'refused' | 'filtered'): string {
  if (kind === 'refused') {
    return `Nothing accepts connections on port ${port}. Check that the proxy runs (Set up again on the Deployments tab, or docker ps for bastion-caddy; in nginx mode, systemctl status nginx).`;
  }
  return (
    `Allow inbound TCP ${port} from anywhere (0.0.0.0/0 and ::/0) in the server’s firewall or cloud security group ` +
    `(AWS: Type ${awsRuleType(port)}, Source 0.0.0.0/0): certificate authorities validate from many addresses. On the host: sudo ufw allow ${port}/tcp.`
  );
}

/** Ports 80 and 443 of `address`, as BastionSSH reaches them. */
export async function checkPorts(address: string, deps: DomainDeps = defaultDomainDeps): Promise<DeployPortCheck[]> {
  return Promise.all(
    ([80, 443] as const).map(async (port): Promise<DeployPortCheck> => {
      const r = await checkTcp(address, port, deps.diagnostics, 5_000);
      r.socket?.destroy();
      if (r.kind === 'connected') return { port, status: 'open', detail: r.outcome.detail };
      if (r.kind === 'refused') return { port, status: 'closed', detail: r.outcome.detail, remediation: portRemediation(port, 'refused') };
      if (r.kind === 'filtered' || r.kind === 'unreachable') return { port, status: 'filtered', detail: r.outcome.detail, remediation: portRemediation(port, 'filtered') };
      return { port, status: 'error', detail: r.outcome.detail };
    }),
  );
}

/** State derived now from what the server reported. */
export function withState(facts: readonly DeployCertFacts[], now = Date.now()): DeployCertificate[] {
  return facts.map((f) => ({ ...f, ...deployCertState(f, now) }));
}

export interface ReportInput {
  app: string;
  config: Pick<DeployAppConfig, 'domains' | 'tls'>;
  proxy: DeployProxyMode;
  server: Pick<ServerRow, 'host'>;
  remote: Pick<Remote, 'run'>;
  /** Certificate facts from the server (bastionctl certs, or the nginx helper). */
  certificates: () => Promise<DeployCertFacts[]>;
  deps?: DomainDeps;
  now?: number;
}

/** DNS, ports and certificates of one app, all checked now. */
export async function domainsReport(input: ReportInput): Promise<DeployDomainsReport> {
  const deps = input.deps ?? defaultDomainDeps;
  const { config: app } = input;
  const acme = app.tls === 'auto' || app.tls === 'staging';
  const [server, certs] = await Promise.all([
    serverAddresses(input.server, input.remote, deps),
    input.certificates().then(
      (facts) => ({ list: withState(facts, input.now), error: null }),
      (err: Error) => ({ list: [] as DeployCertificate[], error: err.message }),
    ),
  ]);
  const ipv4 = server.addresses.find((ip) => isIP(ip) === 4) ?? server.addresses[0];
  const [domains, ports] = await Promise.all([
    Promise.all(
      app.domains.map(async (domain) => ({
        domain,
        dns: await checkDomainDns(domain, server.addresses, deps),
        certificate: certs.list.find((c) => c.domain === domain) ?? null,
      })),
    ),
    acme && ipv4 ? checkPorts(ipv4, deps) : Promise.resolve([]),
  ]);
  return {
    app: input.app,
    proxy: input.proxy,
    tls: app.tls,
    serverAddresses: server.addresses,
    addressSource: server.source,
    domains,
    ports,
    certificatesError: certs.error,
    checkedAt: new Date(input.now ?? Date.now()).toISOString(),
  };
}
