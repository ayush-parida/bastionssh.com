import { describe, it, expect } from 'vitest';
import { formatCaa, formatSoa, joinTxtChunks } from './records.js';
import { describeDnsError, isEmptyAnswer, isNotFound, NXDOMAIN_MESSAGE } from './errors.js';

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

describe('empty answers versus missing names', () => {
  it('treats ENODATA as an empty set and ENOTFOUND as something to report', () => {
    const noData = Object.assign(new Error('queryMx ENODATA'), { code: 'ENODATA' });
    const missing = Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });

    expect(isEmptyAnswer(noData)).toBe(true);
    expect(isNotFound(noData)).toBe(false);

    expect(isEmptyAnswer(missing)).toBe(false);
    expect(isNotFound(missing)).toBe(true);
    expect(describeDnsError(missing)).toBe(NXDOMAIN_MESSAGE);
  });

  it('falls back to the raw code, then the message, for anything unmapped', () => {
    expect(describeDnsError(Object.assign(new Error('x'), { code: 'ESERVFAIL' }))).toContain('SERVFAIL');
    expect(describeDnsError(Object.assign(new Error('x'), { code: 'EWEIRD' }))).toBe('EWEIRD');
    expect(describeDnsError(new Error('plain failure'))).toBe('plain failure');
  });
});
