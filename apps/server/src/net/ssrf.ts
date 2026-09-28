import { BlockList, isIP } from 'net';
import { lookup } from 'dns/promises';
import { config } from '../config/index.js';

/**
 * Guard for outbound connections to addresses an org member typed in (audit
 * forwarding targets). Unlike the literal check on notification webhooks, the
 * hostname is resolved here and every address it resolves to must be public;
 * the caller then connects to the address returned, not the name, so a DNS
 * answer that changes between the check and the connection cannot redirect it.
 */

/** A target the caller can fix — maps to a 400. */
export class UnsafeTargetError extends Error {}

/** Never reachable, whatever SMT_AUDIT_FORWARD_ALLOW_NETS says: metadata services, "this host", multicast. */
const ALWAYS_BLOCKED = new BlockList();
ALWAYS_BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4');
ALWAYS_BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local, incl. 169.254.169.254
ALWAYS_BLOCKED.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
ALWAYS_BLOCKED.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved + broadcast
ALWAYS_BLOCKED.addAddress('::', 'ipv6');
ALWAYS_BLOCKED.addSubnet('fe80::', 10, 'ipv6'); // link-local
ALWAYS_BLOCKED.addSubnet('ff00::', 8, 'ipv6'); // multicast
ALWAYS_BLOCKED.addAddress('fd00:ec2::254', 'ipv6'); // AWS IMDS over IPv6

/** Internal networks: refused unless the operator allowed them. */
const PRIVATE = new BlockList();
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4'); // carrier-grade NAT, also Alibaba's metadata
PRIVATE.addSubnet('192.0.0.0', 24, 'ipv4');
PRIVATE.addSubnet('198.18.0.0', 15, 'ipv4');
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6'); // unique local
PRIVATE.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64 — reaches IPv4 space
PRIVATE.addSubnet('2002::', 16, 'ipv6'); // 6to4 — ditto
PRIVATE.addSubnet('::', 96, 'ipv6'); // IPv4-compatible (::10.0.0.1), deprecated but ditto
PRIVATE.addSubnet('::ffff:0:0:0', 96, 'ipv6'); // IPv4-translated (SIIT) — ditto

export type AllowNets = readonly { address: string; prefix: number; family: 4 | 6 }[];

function toBlockList(nets: AllowNets): BlockList {
  const list = new BlockList();
  for (const n of nets) list.addSubnet(n.address, n.prefix, n.family === 6 ? 'ipv6' : 'ipv4');
  return list;
}

let configured: BlockList | null = null;
function configuredAllowList(): BlockList {
  configured ??= toBlockList(config.auditForward.allowNets);
  return configured;
}

/** `::ffff:10.0.0.1` is 10.0.0.1 as far as routing goes. */
function unmap(address: string): { address: string; type: 'ipv4' | 'ipv6' } {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return { address: mapped[1]!, type: 'ipv4' };
  return { address, type: isIP(address) === 6 ? 'ipv6' : 'ipv4' };
}

/** Why `address` may not be connected to, or null when it may. */
export function blockedReason(address: string, allow: AllowNets | BlockList = configuredAllowList()): string | null {
  if (!isIP(address)) return 'not an IP address';
  const ip = unmap(address);
  if (ALWAYS_BLOCKED.check(ip.address, ip.type)) return `${address} is a reserved address`;
  const allowList = allow instanceof BlockList ? allow : toBlockList(allow);
  if (PRIVATE.check(ip.address, ip.type) && !allowList.check(ip.address, ip.type)) {
    return `${address} is a private or loopback address (allow it with SMT_AUDIT_FORWARD_ALLOW_NETS)`;
  }
  return null;
}

export interface ResolvedTarget {
  address: string;
  family: 4 | 6;
  /**
   * Every address it resolved to is private and was let through by
   * SMT_AUDIT_FORWARD_ALLOW_NETS: an operator-approved internal network, where
   * plain HTTP is acceptable.
   */
  internal: boolean;
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

/**
 * Resolve `host` and return an address safe to connect to. Every address the
 * name resolves to is checked, not just the first: a name answering with one
 * public and one internal address is refused outright.
 */
export async function resolveSafeTarget(
  host: string,
  opts: { allow?: AllowNets; resolver?: Resolver } = {},
): Promise<ResolvedTarget> {
  const allow = opts.allow ? toBlockList(opts.allow) : configuredAllowList();
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  let addresses: { address: string; family: number }[];
  if (isIP(bare)) {
    addresses = [{ address: bare, family: isIP(bare) }];
  } else {
    try {
      addresses = await (opts.resolver ?? systemResolver)(bare);
    } catch {
      throw new UnsafeTargetError(`Could not resolve ${host}`);
    }
    if (!addresses.length) throw new UnsafeTargetError(`Could not resolve ${host}`);
  }
  let internal = true;
  for (const a of addresses) {
    const reason = blockedReason(a.address, allow);
    if (reason) throw new UnsafeTargetError(`Refusing to connect to ${host}: ${reason}`);
    const ip = unmap(a.address);
    if (!PRIVATE.check(ip.address, ip.type)) internal = false;
  }
  const first = addresses[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4, internal };
}
