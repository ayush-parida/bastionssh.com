import { BlockList, isIP } from 'node:net';

/**
 * Ready-to-paste fixes for the failures diagnostics can see. Kept apart from the
 * probes so the wording can be tested without opening a socket.
 */

/** What the target speaks, which decides the hints (and the AWS rule type). */
export type DiagnosticService = 'ssh' | 'ftp' | 'ftps' | 'ftps-implicit' | 'http' | 'https';

export const SERVICE_LABEL: Record<DiagnosticService, string> = {
  ssh: 'SSH',
  ftp: 'FTP',
  ftps: 'FTPS',
  'ftps-implicit': 'FTPS',
  http: 'HTTP',
  https: 'HTTPS',
};

const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4'); // carrier-grade NAT, Tailscale
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addSubnet('fe80::', 10, 'ipv6');
PRIVATE.addAddress('::1', 'ipv6');

/**
 * True for addresses that never cross the public internet. A connection to one
 * leaves from this host's own network, so its public IP is the wrong source to
 * allow.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return PRIVATE.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** `1.2.3.4/32` or `2001:db8::1/128` — a rule matching exactly one address. */
export function singleHostCidr(ip: string): string {
  return `${ip}/${isIP(ip) === 6 ? 128 : 32}`;
}

/** How the AWS console names an inbound rule for this port. */
export function awsRuleType(port: number): string {
  switch (port) {
    case 22:
      return 'SSH';
    case 80:
      return 'HTTP';
    case 443:
      return 'HTTPS';
    default:
      return `Custom TCP, Port range ${port}`;
  }
}

export interface FirewallContext {
  port: number;
  service: DiagnosticService;
  /** This app's public IP, when known. */
  egressIp: string | null;
  /** The address the connection was attempted to. */
  targetAddress: string;
}

/**
 * The rule to add when a port is filtered, e.g.
 * "Allow inbound TCP 22 from 49.43.168.212/32 (AWS security group: Type SSH, Source 49.43.168.212/32)".
 */
export function firewallRemediation(ctx: FirewallContext): string {
  const { port, service, egressIp, targetAddress } = ctx;
  const passive =
    service === 'ftp' || service === 'ftps' || service === 'ftps-implicit'
      ? ' Passive-mode FTP also needs the server’s passive port range open to the same source.'
      : '';

  if (isPrivateAddress(targetAddress)) {
    return (
      `${targetAddress} is a private address, so the connection comes from this app’s own host or ` +
      `container network, not its public IP. Allow inbound TCP ${port} from the app host’s private ` +
      `address or subnet, and check that both are on the same network or VPN.${passive}`
    );
  }

  if (!egressIp) {
    return (
      `Allow inbound TCP ${port} from this app’s public IP in the server’s firewall or cloud security ` +
      `group. The IP could not be determined automatically — set SMT_EGRESS_IP, or check Settings.${passive}`
    );
  }

  const cidr = singleHostCidr(egressIp);
  return (
    `Allow inbound TCP ${port} from ${cidr} (AWS security group: Type ${awsRuleType(port)}, Source ${cidr}). ` +
    `On the host itself: sudo ufw allow from ${egressIp} to any port ${port} proto tcp.${passive}`
  );
}

/** Nothing listens on the port, or a firewall rejects (rather than drops) the connection. */
export function refusedRemediation(port: number, service: DiagnosticService): string {
  const check = `sudo ss -ltnp | grep ':${port} '`;
  switch (service) {
    case 'ssh':
      return (
        `Check that the SSH daemon is running and listening on port ${port}: ${check} ` +
        `(start it with sudo systemctl start ssh, or sshd on RHEL-family systems). If it listens on ` +
        `another port, update the port here. A firewall set to REJECT gives the same answer.`
      );
    case 'http':
    case 'https':
      return `Check that the storage service is running and listening on port ${port}: ${check}. A firewall set to REJECT gives the same answer.`;
    default:
      return (
        `Check that the FTP server is running and listening on port ${port}: ${check}. Implicit FTPS ` +
        `usually listens on 990, FTP and explicit FTPS on 21. A firewall set to REJECT gives the same answer.`
      );
  }
}

/** No route to the host at all. */
export function unreachableRemediation(targetAddress: string): string {
  if (isPrivateAddress(targetAddress)) {
    return (
      `${targetAddress} is a private address that this app has no route to. Run BastionSSH on the same ` +
      `network or VPN as the server, or use its public address.`
    );
  }
  return (
    `Check that the host is powered on and the address is right. A cloud instance that was stopped and ` +
    `started may have a new public IP; a firewall answering "host prohibited" also shows up this way.`
  );
}
