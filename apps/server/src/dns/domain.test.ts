import { describe, it, expect } from 'vitest';
import { isPublicAddress, normalizeDomain } from './domain.js';
import { DnsError } from './errors.js';

describe('normalizeDomain', () => {
  it('accepts a plain domain', () => {
    expect(normalizeDomain('example.com')).toBe('example.com');
    expect(normalizeDomain('sub.example.co.uk')).toBe('sub.example.co.uk');
  });

  it('takes the host out of whatever was pasted', () => {
    expect(normalizeDomain('https://example.com/some/path?q=1')).toBe('example.com');
    expect(normalizeDomain('http://user:pw@example.com:8443/')).toBe('example.com');
    expect(normalizeDomain('example.com/path')).toBe('example.com');
    expect(normalizeDomain('example.com:8080')).toBe('example.com');
    expect(normalizeDomain('  EXAMPLE.com.  ')).toBe('example.com');
  });

  it('converts unicode domains to punycode', () => {
    expect(normalizeDomain('bücher.de')).toBe('xn--bcher-kva.de');
    expect(normalizeDomain('日本.jp')).toBe('xn--wgv71a.jp');
  });

  it('rejects an IP address with advice, in every form it arrives in', () => {
    expect(() => normalizeDomain('8.8.8.8')).toThrow(/IP address/);
    expect(() => normalizeDomain('8.8.8.8:53')).toThrow(/IP address/);
    expect(() => normalizeDomain('::1')).toThrow(/IP address/);
    expect(() => normalizeDomain('2606:4700:4700::1111')).toThrow(/IP address/);
    expect(() => normalizeDomain('[::1]:53')).toThrow(/IP address/);
    expect(() => normalizeDomain('https://[2606:4700::1111]:8443/x')).toThrow(/IP address/);
  });

  it('rejects input that is not a domain', () => {
    for (const bad of ['', '   ', 'localhost', 'example', 'exa mple.com', '-bad.com', 'a..b.com']) {
      expect(() => normalizeDomain(bad), bad).toThrow(DnsError);
    }
  });

  it('rejects a name that is too long', () => {
    expect(() => normalizeDomain(`${'a'.repeat(60)}.`.repeat(5) + 'com')).toThrow(/too long/);
  });

  it('answers 400 for every rejection, since the caller can fix it', () => {
    try {
      normalizeDomain('nope');
      expect.unreachable();
    } catch (err) {
      expect((err as DnsError).statusCode).toBe(400);
    }
  });
});

describe('isPublicAddress', () => {
  it('accepts routable addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '52.94.236.248', '2606:4700:4700::1111']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it('refuses private, loopback, link-local and metadata addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.4.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('refuses anything that is not an address at all', () => {
    expect(isPublicAddress('example.com')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
  });

  it('allows a public address inside a private second octet range', () => {
    expect(isPublicAddress('172.32.0.1')).toBe(true);
    expect(isPublicAddress('172.15.0.1')).toBe(true);
  });
});
