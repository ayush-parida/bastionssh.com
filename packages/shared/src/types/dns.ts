export const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA'] as const;

export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

/** A server in the org whose host is exactly this record's value. */
export interface DnsServerMatch {
  id: string;
  name: string;
}

export interface DnsRecord {
  /** Rendered value: an address, a hostname, the quoted text, the SOA line. */
  value: string;
  /** Seconds, when the resolver reports it (address records only). */
  ttl?: number;
  /** MX preference. */
  priority?: number;
  /** Set when the value matches a server you manage. */
  server?: DnsServerMatch;
}

export interface DnsRecordSet {
  type: DnsRecordType;
  records: DnsRecord[];
  /** Why this type came back empty: `NODATA`, `SERVFAIL`, a timeout. */
  error?: string;
}

export interface DnsNameserver {
  host: string;
  addresses: string[];
  /** Set when the nameserver's own address could not be resolved. */
  error?: string;
}

/** One resolver's answer for the A records, used to spot propagation lag. */
export interface DnsResolverAnswer {
  /** `Cloudflare`, `Google`, or the authoritative nameserver's hostname. */
  name: string;
  address: string;
  /** True for the domain's own nameservers. */
  authoritative: boolean;
  addresses: string[];
  error?: string;
  /** False when this answer differs from the most common one. */
  agrees: boolean;
}

export interface DnsPropagation {
  answers: DnsResolverAnswer[];
  /** True when every resolver that answered returned the same addresses. */
  consistent: boolean;
}

export interface DnsLookupResult {
  /** The domain as queried: lowercased, unicode converted to punycode. */
  domain: string;
  /** What the user typed, when it differed. */
  input?: string;
  nameservers: DnsNameserver[];
  records: DnsRecordSet[];
  propagation: DnsPropagation;
  queriedAt: string;
  /** Milliseconds the whole lookup took. */
  durationMs: number;
}
