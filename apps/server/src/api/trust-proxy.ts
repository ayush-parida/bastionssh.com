import type { FastifyRequest } from 'fastify';

/**
 * With trustProxy off, a request arriving through a reverse proxy gets the
 * proxy's address as req.ip, so every user shares one rate-limit bucket and one
 * audit IP. The returned onRequest hook says so once, the first time a
 * forwarded request shows up; null when a proxy is already trusted.
 */
export function untrustedForwardedForHook(
  trustProxy: boolean | number | string,
): ((req: FastifyRequest) => Promise<void>) | null {
  if (trustProxy !== false) return null;
  let warned = false;
  return async (req) => {
    if (warned || req.headers['x-forwarded-for'] === undefined) return;
    warned = true;
    req.log.warn(
      { ip: req.ip },
      'Received X-Forwarded-For but SMT_TRUST_PROXY is not set: client IPs (rate limits, audit log) will be the proxy address. Set SMT_TRUST_PROXY to your proxy hop count or IP/CIDR list.',
    );
  };
}
