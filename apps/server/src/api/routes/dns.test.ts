import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * No real queries: a fake resolver stands in for `node:dns`, so the module's
 * own parsing, guards and comparison logic are what is under test. The factory
 * is self-contained and parks its state on `globalThis`: a mock of a built-in
 * is hoisted above everything, and importing the mocked module back into the
 * test file breaks that ordering.
 */
vi.mock('node:dns/promises', () => {
  const state = {
    /** A answers keyed by the resolver address; `system` is the unpinned one. */
    a: {
      system: ['52.1.2.3'],
      '1.1.1.1': ['52.1.2.3'],
      '8.8.8.8': ['52.1.2.3'],
      '9.9.9.9': ['198.51.100.7'],
      '208.67.222.222': ['52.1.2.3'],
      '203.0.113.53': ['52.1.2.3'],
    } as Record<string, string[]>,
    ns: ['ns1.example.com', 'ns2.example.com'],
    nsAddresses: {
      'ns1.example.com': ['203.0.113.53'],
      // Private on purpose: it must never be queried
      'ns2.example.com': ['10.0.0.53'],
    } as Record<string, string[]>,
    /** Every resolver address that was asked about the domain itself. */
    queried: [] as string[],
  };
  (globalThis as unknown as { __dnsState: typeof state }).__dnsState = state;

  function noData(): never {
    const err = new Error('queryA ENODATA') as Error & { code: string };
    err.code = 'ENODATA';
    throw err;
  }

  // Per-instance servers live here rather than in a class field: esbuild
  // compiles class fields through a module-level helper, and this factory is
  // hoisted above it, so a field initializer would fail at import time.
  const pinned = new WeakMap<object, string[]>();

  class Resolver {
    setServers(list: string[]) {
      pinned.set(this, list);
    }
    key() {
      return pinned.get(this)?.[0] ?? 'system';
    }
    async resolve4(name: string, opts?: { ttl?: boolean }) {
      const nsAddresses = state.nsAddresses[name];
      if (nsAddresses && this.key() === 'system') return nsAddresses;
      state.queried.push(this.key());
      const answer = state.a[this.key()];
      if (!answer) noData();
      return opts?.ttl ? answer.map((address) => ({ address, ttl: 300 })) : answer;
    }
    async resolve6(): Promise<never> {
      return noData();
    }
    async resolveCname(): Promise<never> {
      return noData();
    }
    async resolveNs() {
      return state.ns;
    }
    async resolveMx() {
      return [
        { priority: 20, exchange: 'alt.mail.example.com' },
        { priority: 10, exchange: 'mail.example.com' },
      ];
    }
    async resolveTxt() {
      return [['v=spf1 ', 'include:_spf.example.com ~all']];
    }
    async resolveSoa() {
      return {
        nsname: 'ns1.example.com',
        hostmaster: 'hostmaster.example.com',
        serial: 2026091301,
        refresh: 7200,
        retry: 3600,
        expire: 604800,
        minttl: 300,
      };
    }
    async resolveCaa() {
      return [{ critical: 0, issue: 'letsencrypt.org' }];
    }
  }

  return { Resolver };
});

import { nanoid } from 'nanoid';
import type { DnsLookupResult, DnsRecordSet, DnsRecordType } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { servers } from '../../db/schema.js';
import { seedOrg, seedUser } from './test-utils.js';

/** Read lazily: the mock factory runs on the first import of the resolver. */
function queried(): string[] {
  return (globalThis as unknown as { __dnsState: { queried: string[] } }).__dnsState.queried;
}

function setOf(body: DnsLookupResult, type: DnsRecordType): DnsRecordSet {
  return body.records.find((r) => r.type === type)!;
}

describe('dns lookup route', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let viewer: ReturnType<typeof seedUser>;

  beforeAll(async () => {
    await runMigrations();
    const orgId = seedOrg('org-dns');
    viewer = seedUser(orgId, 'viewer');
    getDb()
      .insert(servers)
      .values({
        id: nanoid(),
        orgId,
        name: 'web-1',
        host: '52.1.2.3',
        username: 'root',
        createdBy: viewer.userId,
      })
      .run();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function lookup(domain: string): Promise<DnsLookupResult> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/dns/lookup?domain=${encodeURIComponent(domain)}`,
      headers: viewer.headers,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as DnsLookupResult;
  }

  it('normalises what was pasted and returns every record type', async () => {
    const body = await lookup('https://Example.com./path');
    expect(body.domain).toBe('example.com');
    expect(body.input).toBe('https://Example.com./path');

    expect(setOf(body, 'A').records[0]).toMatchObject({ value: '52.1.2.3', ttl: 300 });
    expect(setOf(body, 'MX').records.map((r) => r.value)).toEqual([
      'mail.example.com',
      'alt.mail.example.com',
    ]);
    expect(setOf(body, 'TXT').records[0]!.value).toBe('v=spf1 include:_spf.example.com ~all');
    expect(setOf(body, 'SOA').records[0]!.value).toContain('serial 2026091301');
    expect(setOf(body, 'CAA').records[0]!.value).toBe('0 issue "letsencrypt.org"');
    // No AAAA and no CNAME is an empty set, not an error
    expect(setOf(body, 'AAAA')).toEqual({ type: 'AAAA', records: [] });
    expect(setOf(body, 'CNAME').error).toBeUndefined();
  });

  it('labels the record that points at a server in the inventory', async () => {
    const body = await lookup('example.com');
    expect(setOf(body, 'A').records[0]!.server).toEqual({ id: expect.any(String), name: 'web-1' });
    expect(setOf(body, 'MX').records[0]!.server).toBeUndefined();
  });

  it('lists the nameservers with their addresses', async () => {
    const body = await lookup('example.com');
    expect(body.nameservers).toEqual([
      { host: 'ns1.example.com', addresses: ['203.0.113.53'] },
      { host: 'ns2.example.com', addresses: ['10.0.0.53'] },
    ]);
  });

  it('flags the resolver that has not caught up', async () => {
    const body = await lookup('example.com');
    expect(body.propagation.consistent).toBe(false);
    const byName = new Map(body.propagation.answers.map((a) => [a.name, a]));
    expect(byName.get('Quad9')!.agrees).toBe(false);
    expect(byName.get('Quad9')!.addresses).toEqual(['198.51.100.7']);
    expect(byName.get('Cloudflare')!.agrees).toBe(true);
  });

  it('never sends a query to a nameserver on a private address', async () => {
    queried().length = 0;
    const body = await lookup('example.com');
    expect(
      body.propagation.answers.filter((a) => a.authoritative).map((a) => a.name),
    ).toEqual(['ns1.example.com']);
    expect(queried()).toContain('203.0.113.53');
    expect(queried()).not.toContain('10.0.0.53');
  });

  it('refuses input that is not a domain', async () => {
    for (const bad of ['not a domain', '8.8.8.8', 'localhost']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/dns/lookup?domain=${encodeURIComponent(bad)}`,
        headers: viewer.headers,
      });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error).toBeTruthy();
    }
    const missing = await app.inject({
      method: 'GET',
      url: '/api/dns/lookup',
      headers: viewer.headers,
    });
    expect(missing.statusCode).toBe(400);
  });

  it('requires a signed-in user', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/dns/lookup?domain=example.com' });
    expect(res.statusCode).toBe(401);
  });
});
