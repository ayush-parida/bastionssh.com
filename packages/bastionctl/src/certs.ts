import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DeployAppConfig, DeployCertFacts, DeployCertSource } from '@smt/shared';
import { certPaths } from './caddy.js';
import { loadConfig } from './config.js';
import type { Ctx } from './context.js';
import { BastionError, PROXY_CONTAINER } from './names.js';
import { proxyMode } from './nginx.js';
import { proxyContainer } from './proxy.js';

/**
 * Certificate status (deployments spec §6): for each of an app's domains,
 * the certificate Caddy holds — issuer and validity read from Caddy's own
 * storage — and the latest issuance or renewal error Caddy logged for it.
 * Caddy writes its storage as root with mode 0600, so the files are read
 * with `cat` inside the proxy container (argv, no shell), not from the
 * mounted folder. Only facts are reported: BastionSSH derives the state
 * (valid, expiring, failing…) from them on every read, and keeps nothing.
 */

/** Caddy's storage inside the proxy container (`<root>/proxy/data` is mounted at /data). */
export const CADDY_CERT_DIR = '/data/caddy/certificates';
/** How much of Caddy's log is searched for errors. */
const LOG_LINES = 2000;

export interface CertInfo {
  issuer: string;
  notBefore: string;
  notAfter: string;
}

/** Issuer, validity of the first (leaf) certificate in PEM text, or null. */
export function parseCertificate(pem: string): CertInfo | null {
  const begin = pem.indexOf('-----BEGIN CERTIFICATE-----');
  if (begin === -1) return null;
  try {
    const cert = new X509Certificate(pem.slice(begin));
    const fields = new Map(
      cert.issuer.split('\n').map((line) => {
        const eq = line.indexOf('=');
        return [line.slice(0, eq), line.slice(eq + 1)] as const;
      }),
    );
    const issuer = [fields.get('O'), fields.get('CN')].filter(Boolean).join(' ') || cert.issuer.replace(/\n/g, ', ');
    return { issuer, notBefore: new Date(cert.validFrom).toISOString(), notAfter: new Date(cert.validTo).toISOString() };
  } catch {
    return null;
  }
}

/** Caddy's folder name for a domain: `*.example.com` is stored as `wildcard_.example.com`. */
export function storageName(domain: string): string {
  return domain.startsWith('*.') ? `wildcard_.${domain.slice(2)}` : domain;
}

export function sourceFor(tls: DeployAppConfig['tls']): DeployCertSource {
  if (typeof tls !== 'string') return 'files';
  if (tls === 'staging') return 'staging';
  if (tls === 'internal') return 'internal';
  return 'acme';
}

/** Whether a folder under certificates/ belongs to the issuer `source` uses (`local` is Caddy's internal CA). */
export function issuerMatches(source: DeployCertSource, issuerDir: string): boolean {
  if (source === 'internal') return issuerDir === 'local';
  if (issuerDir === 'local') return false;
  return source === 'staging' ? issuerDir.includes('staging') : !issuerDir.includes('staging');
}

/**
 * The latest TLS error Caddy logged per domain, from its JSON log lines
 * (`tls.obtain`, `tls.renew`, `tls.issuance.*` at level error).
 */
export function parseCaddyErrors(log: string): Map<string, { at: string | null; message: string }> {
  const errors = new Map<string, { at: string | null; message: string; ts: number }>();
  for (const line of log.split('\n')) {
    const start = line.indexOf('{');
    if (start === -1) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line.slice(start)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.level !== 'error' || typeof entry.logger !== 'string' || !entry.logger.startsWith('tls')) continue;
    const identifiers = [entry.identifier, ...(Array.isArray(entry.identifiers) ? entry.identifiers : [])].filter((v): v is string => typeof v === 'string');
    if (identifiers.length === 0) continue;
    const ts = typeof entry.ts === 'number' ? entry.ts : 0;
    const detail = [entry.msg, entry.error].filter((v): v is string => typeof v === 'string').join(': ');
    // eslint-disable-next-line no-control-regex
    const message = detail.replace(/[\0-\x1f\x7f]/g, ' ').slice(0, 500);
    for (const id of identifiers) {
      const prev = errors.get(id);
      if (prev && prev.ts > ts) continue;
      errors.set(id, { at: ts ? new Date(ts * 1000).toISOString() : null, message, ts });
    }
  }
  return new Map([...errors].map(([id, { at, message }]) => [id, { at, message }]));
}

/** One domain's facts from what was read. */
export function certificateFor(domain: string, source: DeployCertSource, info: CertInfo | null, lastError: DeployCertFacts['lastError']): DeployCertFacts {
  return { domain, source, issuer: info?.issuer ?? null, notBefore: info?.notBefore ?? null, notAfter: info?.notAfter ?? null, lastError };
}

async function catInProxy(ctx: Pick<Ctx, 'docker'>, file: string): Promise<string | null> {
  const r = await ctx.docker.exec(PROXY_CONTAINER, ['cat', file], 15_000);
  return r.exitCode === 0 ? r.stdout : null;
}

/** `certs <app>`: every domain's certificate as Caddy has it (Caddy mode). */
export async function certs(ctx: Ctx, app: string): Promise<DeployCertFacts[]> {
  const config = loadConfig(ctx.layout, app);
  if (proxyMode(ctx.layout) === 'nginx') {
    throw new BastionError(`In nginx mode certificates belong to certbot on the host: sudo bastion-nginx status ${app}`);
  }
  const source = sourceFor(config.tls);

  if (source === 'files') {
    // The copy the proxy serves, else the app's own file
    const tls = config.tls as { cert: string; key: string };
    let pem: string | null = null;
    for (const file of [path.join(ctx.layout.proxy, certPaths(app).cert), path.join(ctx.layout.app(app), tls.cert)]) {
      try {
        pem = fs.readFileSync(file, 'utf8');
        break;
      } catch {
        // next
      }
    }
    const info = pem ? parseCertificate(pem) : null;
    return config.domains.map((d) => certificateFor(d, source, info, null));
  }

  const proxy = await proxyContainer(ctx);
  if (proxy?.state !== 'running') throw new BastionError('The proxy is not running on this server (run bastionctl setup)');
  const listing = await ctx.docker.exec(PROXY_CONTAINER, ['find', CADDY_CERT_DIR, '-type', 'f', '-name', '*.crt'], 15_000);
  // certificates/<issuer>/<name>/<name>.crt
  const files = (listing.exitCode === 0 ? listing.stdout : '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${CADDY_CERT_DIR}/`))
    .map((file) => {
      const [issuerDir, name, base] = file.slice(CADDY_CERT_DIR.length + 1).split('/');
      return { file, issuerDir: issuerDir ?? '', name: name ?? '', ok: base === `${name}.crt` };
    })
    .filter((f) => f.ok && issuerMatches(source, f.issuerDir));
  const errors = parseCaddyErrors(await ctx.docker.logsTail(PROXY_CONTAINER, LOG_LINES));

  const out: DeployCertFacts[] = [];
  for (const domain of config.domains) {
    let best: CertInfo | null = null;
    for (const f of files.filter((x) => x.name === storageName(domain))) {
      const pem = await catInProxy(ctx, f.file);
      const info = pem ? parseCertificate(pem) : null;
      if (info && (!best || info.notAfter > best.notAfter)) best = info;
    }
    out.push(certificateFor(domain, source, best, errors.get(domain) ?? null));
  }
  return out;
}
