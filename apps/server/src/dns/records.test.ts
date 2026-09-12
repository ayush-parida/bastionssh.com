import { describe, it, expect } from 'vitest';
import { formatCaa, formatSoa, joinTxtChunks } from './records.js';

describe('record formatting', () => {
  it('rejoins TXT chunks into one string per record', () => {
    expect(joinTxtChunks([['v=spf1 ', 'include:_spf.google.com ~all'], ['single']])).toEqual([
      'v=spf1 include:_spf.google.com ~all',
      'single',
    ]);
    expect(joinTxtChunks([])).toEqual([]);
  });

  it('renders a SOA with the serial, which is what people check', () => {
    expect(
      formatSoa({
        nsname: 'ns1.example.com',
        hostmaster: 'hostmaster.example.com',
        serial: 2026091301,
        refresh: 7200,
        retry: 3600,
        expire: 604800,
        minttl: 300,
      }),
    ).toEqual({
      value: 'ns1.example.com · hostmaster hostmaster.example.com · serial 2026091301',
      ttl: 300,
    });
  });

  it('renders a CAA entry in zone-file order', () => {
    expect(formatCaa({ critical: 0, issue: 'letsencrypt.org' })).toEqual({
      value: '0 issue "letsencrypt.org"',
    });
    expect(formatCaa({ critical: 128, iodef: 'mailto:a@b.com' })).toEqual({
      value: '128 iodef "mailto:a@b.com"',
    });
  });
});
