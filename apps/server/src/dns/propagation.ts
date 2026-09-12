import type { DnsPropagation, DnsResolverAnswer } from '@smt/shared';
import { describeDnsError, isEmptyAnswer } from './errors.js';
import { createResolver, DEFAULT_TIMEOUT_MS } from './records.js';

/**
 * A fixed list. Letting a caller name the resolver would turn this endpoint
 * into a way to send UDP to any host on port 53.
 */
export const PUBLIC_RESOLVERS: { name: string; address: string }[] = [
  { name: 'Cloudflare', address: '1.1.1.1' },
  { name: 'Google', address: '8.8.8.8' },
  { name: 'Quad9', address: '9.9.9.9' },
  { name: 'OpenDNS', address: '208.67.222.222' },
];

/** How many of the domain's own nameservers we compare against. */
export const MAX_AUTHORITATIVE = 4;

export interface ResolverTarget {
  name: string;
  address: string;
  authoritative: boolean;
}

/** Sorted addresses, so two resolvers returning the same set in a different order agree. */
export function signature(addresses: string[]): string {
  return [...addresses].sort().join(',');
}

/**
 * Mark the answers that differ from the most common one. Ties go to the answer
 * seen first, which is Cloudflare, so the table has a stable reference point.
 */
export function compareAnswers(answers: DnsResolverAnswer[]): DnsPropagation {
  const answered = answers.filter((a) => !a.error && a.addresses.length > 0);
  if (answered.length === 0) {
    return { answers: answers.map((a) => ({ ...a, agrees: true })), consistent: true };
  }

  const counts = new Map<string, number>();
  for (const answer of answered) {
    const key = signature(answer.addresses);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let winner = signature(answered[0]!.addresses);
  for (const [key, count] of counts) {
    if (count > (counts.get(winner) ?? 0)) winner = key;
  }

  return {
    answers: answers.map((a) => ({
      ...a,
      agrees: a.error || a.addresses.length === 0 ? true : signature(a.addresses) === winner,
    })),
    consistent: counts.size === 1,
  };
}

async function askOne(
  target: ResolverTarget,
  domain: string,
  timeoutMs: number,
): Promise<DnsResolverAnswer> {
  const base = { name: target.name, address: target.address, authoritative: target.authoritative, agrees: true };
  try {
    const addresses = await createResolver([target.address], timeoutMs).resolve4(domain);
    return { ...base, addresses };
  } catch (err) {
    if (isEmptyAnswer(err)) return { ...base, addresses: [] };
    return { ...base, addresses: [], error: describeDnsError(err) };
  }
}

/** Ask every resolver for the A records and report who disagrees. */
export async function checkPropagation(
  domain: string,
  targets: ResolverTarget[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DnsPropagation> {
  const answers = await Promise.all(targets.map((t) => askOne(t, domain, timeoutMs)));
  return compareAnswers(answers);
}
