import { describe, it, expect } from 'vitest';
import type { DnsRecordSet } from '@smt/shared';
import { isNxdomain, matchServers } from './index.js';
import { NXDOMAIN_MESSAGE } from './errors.js';

const servers = [
  { id: 's1', name: 'web-1', host: '52.1.2.3' },
  { id: 's2', name: 'db-1', host: 'db.internal.example.com' },
];

describe('matchServers', () => {
  it('labels address records that point at a server you manage', () => {
    const sets: DnsRecordSet[] = [
      { type: 'A', records: [{ value: '52.1.2.3' }, { value: '203.0.113.9' }] },
    ];
    const [a] = matchServers(sets, servers);
    expect(a!.records[0]!.server).toEqual({ id: 's1', name: 'web-1' });
    expect(a!.records[1]!.server).toBeUndefined();
  });

  it('matches a CNAME target by hostname, ignoring case and the trailing dot', () => {
    const sets: DnsRecordSet[] = [
      { type: 'CNAME', records: [{ value: 'DB.Internal.Example.com.' }] },
    ];
    expect(matchServers(sets, servers)[0]!.records[0]!.server).toEqual({ id: 's2', name: 'db-1' });
  });

  it('leaves record types that cannot name a machine alone', () => {
    const sets: DnsRecordSet[] = [{ type: 'TXT', records: [{ value: '52.1.2.3' }] }];
    expect(matchServers(sets, servers)[0]!.records[0]!.server).toBeUndefined();
  });

  it('is a no-op with no servers', () => {
    const sets: DnsRecordSet[] = [{ type: 'A', records: [{ value: '52.1.2.3' }] }];
    expect(matchServers(sets, [])).toEqual(sets);
  });

  it('keeps the first server when two share a host', () => {
    const sets: DnsRecordSet[] = [{ type: 'A', records: [{ value: '52.1.2.3' }] }];
    const dupes = [...servers, { id: 's3', name: 'web-1-clone', host: '52.1.2.3' }];
    expect(matchServers(sets, dupes)[0]!.records[0]!.server).toEqual({ id: 's1', name: 'web-1' });
  });
});

describe('isNxdomain', () => {
  it('is true when every type is empty and one says the name does not exist', () => {
    expect(
      isNxdomain([
        { type: 'A', records: [], error: NXDOMAIN_MESSAGE },
        { type: 'MX', records: [], error: NXDOMAIN_MESSAGE },
      ]),
    ).toBe(true);
  });

  it('is false when the name exists but simply has no records of a type', () => {
    expect(isNxdomain([{ type: 'A', records: [] }, { type: 'MX', records: [] }])).toBe(false);
  });

  it('is false as soon as any record came back', () => {
    expect(
      isNxdomain([
        { type: 'A', records: [{ value: '1.2.3.4' }] },
        { type: 'MX', records: [], error: NXDOMAIN_MESSAGE },
      ]),
    ).toBe(false);
  });

  it('is false for an unrelated failure such as SERVFAIL', () => {
    expect(isNxdomain([{ type: 'A', records: [], error: 'The nameserver failed to answer (SERVFAIL)' }])).toBe(false);
  });

  it('is false for no sets at all', () => {
    expect(isNxdomain([])).toBe(false);
  });
});
