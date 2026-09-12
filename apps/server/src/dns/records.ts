import { Resolver } from 'node:dns/promises';
import { DNS_RECORD_TYPES, type DnsRecord, type DnsRecordSet, type DnsRecordType } from '@smt/shared';
import { describeDnsError, isEmptyAnswer } from './errors.js';

export const DEFAULT_TIMEOUT_MS = 5_000;

/** A resolver pinned to specific servers, or the host's own when none are given. */
export function createResolver(servers?: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Resolver {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  if (servers?.length) resolver.setServers(servers);
  return resolver;
}

/** TXT answers arrive split into 255-byte chunks that belong to one string. */
export function joinTxtChunks(chunks: string[][]): string[] {
  return chunks.map((parts) => parts.join(''));
}

export function formatSoa(soa: {
  nsname: string;
  hostmaster: string;
  serial: number;
  refresh: number;
  retry: number;
  expire: number;
  minttl: number;
}): DnsRecord {
  return {
    value: `${soa.nsname} · hostmaster ${soa.hostmaster} · serial ${soa.serial}`,
    ttl: soa.minttl,
  };
}

export function formatCaa(entry: Record<string, string | number | boolean>): DnsRecord {
  const critical = Number(entry['critical'] ?? 0);
  const tag = Object.keys(entry).find((k) => k !== 'critical');
  const value = tag ? String(entry[tag]) : '';
  return { value: `${critical} ${tag ?? '?'} "${value}"` };
}

/** One query, converted into a record set. An empty answer is not an error. */
async function fetchSet(
  resolver: Resolver,
  domain: string,
  type: DnsRecordType,
): Promise<DnsRecordSet> {
  try {
    switch (type) {
      case 'A':
      case 'AAAA': {
        const answers =
          type === 'A'
            ? await resolver.resolve4(domain, { ttl: true })
            : await resolver.resolve6(domain, { ttl: true });
        return { type, records: answers.map((a) => ({ value: a.address, ttl: a.ttl })) };
      }
      case 'CNAME':
        return { type, records: (await resolver.resolveCname(domain)).map((value) => ({ value })) };
      case 'NS':
        return { type, records: (await resolver.resolveNs(domain)).map((value) => ({ value })) };
      case 'MX': {
        const answers = await resolver.resolveMx(domain);
        return {
          type,
          records: answers
            .sort((a, b) => a.priority - b.priority)
            .map((m) => ({ value: m.exchange, priority: m.priority })),
        };
      }
      case 'TXT':
        return {
          type,
          records: joinTxtChunks(await resolver.resolveTxt(domain)).map((value) => ({ value })),
        };
      case 'SOA':
        return { type, records: [formatSoa(await resolver.resolveSoa(domain))] };
      case 'CAA':
        return {
          type,
          records: (await resolver.resolveCaa(domain)).map((entry) =>
            formatCaa(entry as unknown as Record<string, string | number | boolean>),
          ),
        };
    }
  } catch (err) {
    if (isEmptyAnswer(err)) return { type, records: [] };
    return { type, records: [], error: describeDnsError(err) };
  }
}

/** Every record type at once; each answers or fails on its own. */
export function fetchAllRecords(resolver: Resolver, domain: string): Promise<DnsRecordSet[]> {
  return Promise.all(DNS_RECORD_TYPES.map((type) => fetchSet(resolver, domain, type)));
}

/** Resolve one nameserver hostname to the addresses we may query. */
export async function resolveNameserver(
  resolver: Resolver,
  host: string,
): Promise<{ addresses: string[]; error?: string }> {
  try {
    return { addresses: await resolver.resolve4(host) };
  } catch (err) {
    if (isEmptyAnswer(err)) return { addresses: [] };
    return { addresses: [], error: describeDnsError(err) };
  }
}
