import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { DnsError } from './errors.js';

const MAX_LENGTH = 253;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Accept what people actually paste: a bare domain, a URL, a trailing dot, a
 * unicode domain, stray whitespace. Everything is reduced to the lowercase
 * punycode form the resolver wants, or rejected with a reason.
 */
export function normalizeDomain(raw: string): string {
  let input = raw.trim();
  if (!input) throw new DnsError('Enter a domain name', 400);

  // A pasted URL: keep the host, drop scheme, path, port, credentials
  if (input.includes('://')) {
    try {
      input = new URL(input).hostname;
    } catch {
      throw new DnsError('That URL could not be read', 400);
    }
  } else {
    // `example.com/path` without a scheme
    input = input.split('/')[0]!.split('?')[0]!;
  }

  // `[::1]` or `[::1]:53`, the bracketed form a URL hands back for IPv6
  const bracketed = input.match(/^\[(.+)\](?::\d+)?$/);
  if (bracketed) {
    input = bracketed[1]!;
  } else if ((input.match(/:/g)?.length ?? 0) === 1) {
    // A single colon is a port; a bare IPv6 address has several, and must
    // survive intact so it is reported as an address rather than a bad name.
    const [host, port] = input.split(':') as [string, string];
    if (/^\d+$/.test(port)) input = host;
  }

  input = input.replace(/\.+$/, '').toLowerCase();
  if (!input) throw new DnsError('Enter a domain name', 400);

  if (isIP(input)) {
    throw new DnsError('That is an IP address. Enter a domain name such as example.com', 400);
  }

  const ascii = domainToASCII(input);
  if (!ascii) throw new DnsError(`"${raw.trim()}" is not a valid domain name`, 400);
  if (ascii.length > MAX_LENGTH) throw new DnsError('That domain name is too long', 400);

  const labels = ascii.split('.');
  if (labels.length < 2) {
    throw new DnsError('Enter a full domain, including the extension, such as example.com', 400);
  }
  for (const label of labels) {
    if (!LABEL.test(label)) throw new DnsError(`"${label}" is not a valid part of a domain name`, 400);
  }
  return ascii;
}

/** IPv4 ranges we refuse to send queries to. */
function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  const [a = 0, b = 0] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, includes cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const address = ip.toLowerCase().split('%')[0]!;
  if (address === '::' || address === '::1') return true;
  if (address.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(address)) return true; // unique local
  if (address.startsWith('ff')) return true; // multicast
  // IPv4-mapped, e.g. ::ffff:127.0.0.1
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]!);
  return false;
}

/**
 * A domain's own nameservers are attacker-controlled input, so their addresses
 * are checked before we send anything to them. Without this, an NS record
 * pointing at 127.0.0.1 or 169.254.169.254 would turn the lookup endpoint into
 * a probe of the host's own network.
 */
export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return !isPrivateV4(ip);
  if (version === 6) return !isPrivateV6(ip);
  return false;
}
