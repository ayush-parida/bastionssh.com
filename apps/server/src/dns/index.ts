import type { DnsLookupResult, DnsNameserver, DnsRecordSet, DnsServerMatch } from '@smt/shared';
import { NXDOMAIN_MESSAGE } from './errors.js';
import { isPublicAddress, normalizeDomain } from './domain.js';
import { createResolver, DEFAULT_TIMEOUT_MS, fetchAllRecords, resolveNameserver } from './records.js';
import {
  checkPropagation,
  MAX_AUTHORITATIVE,
  PUBLIC_RESOLVERS,
  type ResolverTarget,
} from './propagation.js';

export * from './errors.js';
export { normalizeDomain, isPublicAddress } from './domain.js';

/** Record values that can name a machine, and so can be matched to the inventory. */
const MATCHABLE = new Set(['A', 'AAAA', 'CNAME']);

export interface ServerRef {
  id: string;
  name: string;
  host: string;
}

/**
 * Label record values that point at a server in the inventory. This is the
 * question a generic lookup tool cannot answer: not just where the domain
 * points, but which of your machines that is.
 */
export function matchServers(sets: DnsRecordSet[], servers: ServerRef[]): DnsRecordSet[] {
  const byHost = new Map<string, DnsServerMatch>();
  for (const server of servers) {
    const key = server.host.trim().toLowerCase().replace(/\.+$/, '');
    if (key && !byHost.has(key)) byHost.set(key, { id: server.id, name: server.name });
  }
  if (byHost.size === 0) return sets;

  return sets.map((set) =>
    MATCHABLE.has(set.type)
      ? {
          ...set,
          records: set.records.map((record) => {
            const server = byHost.get(record.value.toLowerCase().replace(/\.+$/, ''));
            return server ? { ...record, server } : record;
          }),
        }
      : set,
  );
}

/**
 * True when the name itself does not exist, rather than merely having no
 * records: every type came back empty and at least one said so with NXDOMAIN.
 */
export function isNxdomain(sets: DnsRecordSet[]): boolean {
  return (
    sets.length > 0 &&
    sets.every((set) => set.records.length === 0) &&
    sets.some((set) => set.error === NXDOMAIN_MESSAGE)
  );
}

/** Nameserver hostnames plus the addresses we are allowed to query. */
async function describeNameservers(
  records: DnsRecordSet[],
  timeoutMs: number,
): Promise<DnsNameserver[]> {
  const hosts = records.find((r) => r.type === 'NS')?.records.map((r) => r.value) ?? [];
  const resolver = createResolver(undefined, timeoutMs);
  return Promise.all(
    hosts.map(async (host) => {
      const { addresses, error } = await resolveNameserver(resolver, host);
      return { host, addresses, ...(error && { error }) };
    }),
  );
}

/**
 * A nameserver's address comes from the domain being looked up, so it is
 * untrusted: only public addresses are queried.
 */
function authoritativeTargets(nameservers: DnsNameserver[]): ResolverTarget[] {
  const targets: ResolverTarget[] = [];
  for (const ns of nameservers) {
    const address = ns.addresses.find(isPublicAddress);
    if (address) targets.push({ name: ns.host, address, authoritative: true });
    if (targets.length >= MAX_AUTHORITATIVE) break;
  }
  return targets;
}

export interface LookupOptions {
  timeoutMs?: number;
  /** Skip the multi-resolver comparison (tests, or a quick record-only view). */
  skipPropagation?: boolean;
}

/**
 * One pass over a domain: every record type from the host's own resolver, the
 * nameservers with their addresses, the same A lookup across public resolvers
 * and the domain's own nameservers, and inventory matches.
 */
export async function lookupDomain(
  input: string,
  servers: ServerRef[] = [],
  options: LookupOptions = {},
): Promise<DnsLookupResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const domain = normalizeDomain(input);
  const started = Date.now();

  const records = await fetchAllRecords(createResolver(undefined, timeoutMs), domain);
  const notFound = isNxdomain(records);
  const nameservers = notFound ? [] : await describeNameservers(records, timeoutMs);

  // Comparing resolvers on a name that does not exist tells nobody anything.
  const propagation =
    options.skipPropagation || notFound
      ? { answers: [], consistent: true }
    : await checkPropagation(
        domain,
        [
          ...PUBLIC_RESOLVERS.map((r) => ({ ...r, authoritative: false })),
          ...authoritativeTargets(nameservers),
        ],
        timeoutMs,
      );

  return {
    domain,
    ...(domain !== input.trim().toLowerCase() && { input: input.trim() }),
    notFound,
    nameservers,
    records: matchServers(records, servers),
    propagation,
    queriedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}
