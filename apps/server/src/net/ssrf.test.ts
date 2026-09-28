import { describe, it, expect } from 'vitest';
import { parseAllowNets } from '../config/index.js';
import { blockedReason, resolveSafeTarget, UnsafeTargetError, type Resolver } from './ssrf.js';

const none = parseAllowNets('');
const lan = parseAllowNets('10.1.0.0/16, 127.0.0.1');

describe('blockedReason', () => {
  it.each(['8.8.8.8', '203.0.113.9', '2606:4700::1111'])('lets public %s through', (ip) => {
    expect(blockedReason(ip, none)).toBeNull();
  });

  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.20.1.1',
    '192.168.1.1',
    '100.100.100.200',
    '::1',
    'fd12::1',
    '::ffff:10.0.0.5',
    '64:ff9b::a00:1',
  ])('refuses private %s by default', (ip) => {
    expect(blockedReason(ip, none)).toMatch(/private or loopback/);
  });

  it.each(['169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', 'fe80::1', 'fd00:ec2::254', '::'])(
    'always refuses %s, allow list or not',
    (ip) => {
      expect(blockedReason(ip, parseAllowNets('0.0.0.0/0,::/0'))).toMatch(/reserved/);
    },
  );

  it('lets an operator-allowed network through', () => {
    expect(blockedReason('10.1.2.3', lan)).toBeNull();
    expect(blockedReason('127.0.0.1', lan)).toBeNull();
    expect(blockedReason('10.2.0.1', lan)).toMatch(/private/);
    expect(blockedReason('127.0.0.2', lan)).toMatch(/private/);
  });
});

describe('resolveSafeTarget', () => {
  const answers =
    (...addresses: string[]): Resolver =>
    async () =>
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

  it('returns the checked address to connect to', async () => {
    await expect(resolveSafeTarget('logs.example.com', { allow: none, resolver: answers('203.0.113.9') })).resolves.toEqual({
      address: '203.0.113.9',
      family: 4,
      internal: false,
    });
  });

  it('refuses a name when any of its addresses is internal', async () => {
    await expect(
      resolveSafeTarget('rebind.example.com', { allow: none, resolver: answers('203.0.113.9', '127.0.0.1') }),
    ).rejects.toThrow(UnsafeTargetError);
  });

  it('marks operator-allowed internal targets', async () => {
    await expect(resolveSafeTarget('10.1.0.9', { allow: lan })).resolves.toMatchObject({ internal: true });
    await expect(resolveSafeTarget('[::1]', { allow: none })).rejects.toThrow(/private/);
  });

  it('turns a resolution failure into a clear error', async () => {
    const failing: Resolver = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(resolveSafeTarget('nope.invalid', { allow: none, resolver: failing })).rejects.toThrow(
      'Could not resolve nope.invalid',
    );
  });
});

describe('parseAllowNets', () => {
  it('parses addresses and CIDRs, and rejects anything else', () => {
    expect(parseAllowNets('10.0.0.0/8, ::1')).toEqual([
      { address: '10.0.0.0', prefix: 8, family: 4 },
      { address: '::1', prefix: 128, family: 6 },
    ]);
    expect(() => parseAllowNets('10.0.0.0/33')).toThrow();
    expect(() => parseAllowNets('example.com')).toThrow();
    expect(() => parseAllowNets('10.0.0.0/x')).toThrow();
  });
});
