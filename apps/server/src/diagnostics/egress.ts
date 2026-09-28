import { isIP } from 'node:net';
import type { EgressIpInfo } from '@smt/shared';
import { config, type EgressIpConfig } from '../config/index.js';
import logger from '../logger.js';

/**
 * The public address this app's outbound connections leave from — the source a
 * cloud security group or host firewall has to allow. Looked up lazily from IP
 * echo services (never at startup), cached, and overridable with SMT_EGRESS_IP
 * for deployments behind NAT the echo services cannot see through, or where
 * outbound lookups are not wanted at all.
 */

export const EGRESS_CACHE_MS = 10 * 60 * 1000;
/** A failed lookup is retried sooner than a good answer expires, but not on every request. */
export const EGRESS_FAILURE_CACHE_MS = 60 * 1000;
export const EGRESS_LOOKUP_TIMEOUT_MS = 4_000;
/** Any echo service answers with a few bytes; more than this is not an address. */
const MAX_RESPONSE_CHARS = 64;

type Fetch = typeof fetch;

let cached: { info: EgressIpInfo; expiresAt: number } | undefined;
let inflight: Promise<EgressIpInfo> | undefined;

/** Ask each service in turn; the first that answers with an IP address wins. */
export async function lookupEgressIp(
  services: string[],
  fetchImpl: Fetch = fetch,
  timeoutMs = EGRESS_LOOKUP_TIMEOUT_MS,
): Promise<EgressIpInfo> {
  const errors: string[] = [];
  for (const service of services) {
    try {
      const res = await fetchImpl(service, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'text/plain', 'user-agent': 'BastionSSH' },
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.text()).trim();
      if (body.length > MAX_RESPONSE_CHARS || isIP(body) === 0) {
        throw new Error('the response was not an IP address');
      }
      return { ip: body, source: 'lookup', service, checkedAt: new Date().toISOString() };
    } catch (err) {
      errors.push(`${new URL(service).host}: ${(err as Error).message}`);
    }
  }
  return {
    ip: null,
    source: 'unavailable',
    checkedAt: new Date().toISOString(),
    error: errors.length ? errors.join('; ') : 'no IP echo services configured',
  };
}

/**
 * This app's egress IP, per `settings` (config.egressIp by default). Concurrent
 * callers share one lookup; `refresh` skips the cache.
 */
export async function getEgressIp(
  opts: { refresh?: boolean; settings?: EgressIpConfig; fetchImpl?: Fetch } = {},
): Promise<EgressIpInfo> {
  const settings = opts.settings ?? config.egressIp;
  if (settings.mode === 'fixed') {
    return { ip: settings.ip, source: 'configured', checkedAt: null };
  }
  if (settings.mode === 'disabled') {
    return { ip: null, source: 'disabled', checkedAt: null };
  }

  if (!opts.refresh && cached && cached.expiresAt > Date.now()) return cached.info;
  if (inflight) return inflight;

  inflight = lookupEgressIp(settings.services, opts.fetchImpl)
    .then((info) => {
      const ttl = info.ip ? EGRESS_CACHE_MS : EGRESS_FAILURE_CACHE_MS;
      cached = { info, expiresAt: Date.now() + ttl };
      if (!info.ip) logger.warn({ error: info.error }, 'Could not determine the egress IP');
      return info;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

/** Test hook: forget the cached answer. */
export function resetEgressIpCache(): void {
  cached = undefined;
  inflight = undefined;
}
