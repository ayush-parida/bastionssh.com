import { describe, it, expect } from 'vitest';
import {
  awsRuleType,
  firewallRemediation,
  isPrivateAddress,
  refusedRemediation,
  singleHostCidr,
  unreachableRemediation,
} from './remediation.js';

describe('firewallRemediation', () => {
  it('gives a ready-to-paste rule for the egress IP', () => {
    const text = firewallRemediation({ port: 22, service: 'ssh', egressIp: '49.43.168.212', targetAddress: '203.0.113.10' });
    expect(text).toContain(
      'Allow inbound TCP 22 from 49.43.168.212/32 (AWS security group: Type SSH, Source 49.43.168.212/32)',
    );
    expect(text).toContain('sudo ufw allow from 49.43.168.212 to any port 22 proto tcp');
    expect(text).not.toContain('Passive');
  });

  it('uses a custom TCP rule off the well-known ports and mentions passive FTP', () => {
    const text = firewallRemediation({ port: 21, service: 'ftp', egressIp: '49.43.168.212', targetAddress: '203.0.113.10' });
    expect(text).toContain('Type Custom TCP, Port range 21');
    expect(text).toContain('passive port range');
  });

  it('writes a /128 for an IPv6 egress address', () => {
    const text = firewallRemediation({ port: 443, service: 'https', egressIp: '2001:db8::1', targetAddress: '203.0.113.10' });
    expect(text).toContain('from 2001:db8::1/128 (AWS security group: Type HTTPS, Source 2001:db8::1/128)');
  });

  it('does not suggest the public IP for a private target', () => {
    const text = firewallRemediation({ port: 22, service: 'ssh', egressIp: '49.43.168.212', targetAddress: '10.0.0.5' });
    expect(text).toContain('private address');
    expect(text).not.toContain('49.43.168.212');
  });

  it('says how to supply the IP when it is unknown', () => {
    const text = firewallRemediation({ port: 22, service: 'ssh', egressIp: null, targetAddress: '203.0.113.10' });
    expect(text).toContain('SMT_EGRESS_IP');
  });
});

describe('helpers', () => {
  it('names AWS rule types', () => {
    expect(awsRuleType(22)).toBe('SSH');
    expect(awsRuleType(443)).toBe('HTTPS');
    expect(awsRuleType(2222)).toBe('Custom TCP, Port range 2222');
  });

  it('builds single-host CIDRs', () => {
    expect(singleHostCidr('1.2.3.4')).toBe('1.2.3.4/32');
    expect(singleHostCidr('::1')).toBe('::1/128');
  });

  it('recognises private addresses', () => {
    for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.1.1', '100.64.0.9', '127.0.0.1', 'fd12::1', '::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('tailors the refused and unreachable hints', () => {
    expect(refusedRemediation(22, 'ssh')).toContain("sudo ss -ltnp | grep ':22 '");
    expect(refusedRemediation(990, 'ftps-implicit')).toContain('FTP server');
    expect(unreachableRemediation('10.0.0.5')).toContain('VPN');
    expect(unreachableRemediation('203.0.113.10')).toContain('new public IP');
  });
});
