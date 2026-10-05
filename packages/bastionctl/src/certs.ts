import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DeployAppCertificate, DeployAppConfig, DeployCertFacts, DeployCertSource } from '@smt/shared';
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

// ── The app list (`list --json`) ─────────────────────────────────────────────

/** certbot's state the nginx helper keeps (mounted read-only into bastionctl's container by the wrapper). */
export const NGINX_STATE_DIR = '/var/lib/bastion-nginx';
const DAY_MS = 86_400_000;

/** One line for the app list: the certificate expiring first across the app's domains, and the latest error. */
export function summarizeCertificate(facts: readonly DeployCertFacts[], now: Date): DeployAppCertificate | null {
  if (facts.length === 0) return null;
  const first = facts.filter((f) => f.notAfter).sort((a, b) => a.notAfter!.localeCompare(b.notAfter!))[0];
  const error = facts
    .map((f) => f.lastError)
    .filter((e): e is NonNullable<DeployCertFacts['lastError']> => !!e)
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))[0];
  const notAfter = first?.notAfter ?? null;
  return {
    issuer: first?.issuer ?? null,
    notAfter,
    daysLeft: notAfter ? Math.floor((Date.parse(notAfter) - now.getTime()) / DAY_MS) : null,
    lastError: error?.message ?? null,
  };
}

function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Facts for an app with `tls: { cert, key }`: the copy the proxy serves, else the app's own file. */
function fileFacts(ctx: Pick<Ctx, 'layout'>, app: string, config: DeployAppConfig): DeployCertFacts[] {
  const tls = config.tls as { cert: string; key: string };
  const pem = readFileOrNull(path.join(ctx.layout.proxy, certPaths(app).cert)) ?? readFileOrNull(path.join(ctx.layout.app(app), tls.cert));
  const info = pem ? parseCertificate(pem) : null;
  return config.domains.map((d) => certificateFor(d, 'files', info, null));
}

/**
 * In nginx mode: the public certificate the helper copies out of certbot's
 * folder (root only) and certbot's last error, both under its state folder.
 */
export function nginxFacts(stateDir: string, app: string, config: DeployAppConfig): DeployCertFacts[] {
  const cert = config.tls === 'staging' ? `bastion-${app}-staging` : `bastion-${app}`;
  const pem = readFileOrNull(path.join(stateDir, 'certs', `${cert}.pem`));
  const info = pem ? parseCertificate(pem) : null;
  const [at, ...rest] = (readFileOrNull(path.join(stateDir, `${cert}.error`)) ?? '').split('\n');
  // eslint-disable-next-line no-control-regex
  const message = rest.join(' ').replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 500);
  const lastError = message ? { at: at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : null, message } : null;
  return config.domains.map((d) => certificateFor(d, 'certbot', info, lastError));
}

/**
 * Every listed app's certificate summary in a few reads: Caddy's storage is
 * listed once, the certificate files are read in one `cat` run and its log
 * once. An app whose facts cannot be read gets null.
 */
export async function appCertificates(ctx: Ctx, apps: ReadonlyArray<{ app: string; config: DeployAppConfig }>): Promise<Map<string, DeployAppCertificate | null>> {
  const out = new Map<string, DeployAppCertificate | null>();
  const now = ctx.now();
  if (proxyMode(ctx.layout) === 'nginx') {
    for (const { app, config } of apps) out.set(app, summarizeCertificate(nginxFacts(ctx.nginxStateDir ?? NGINX_STATE_DIR, app, config), now));
    return out;
  }
  const fromCaddy: Array<{ app: string; config: DeployAppConfig; source: DeployCertSource }> = [];
  for (const { app, config } of apps) {
    const source = sourceFor(config.tls);
    if (source === 'files') out.set(app, summarizeCertificate(fileFacts(ctx, app, config), now));
    else fromCaddy.push({ app, config, source });
  }
  if (fromCaddy.length === 0) return out;
  try {
    if ((await proxyContainer(ctx))?.state !== 'running') throw new Error('The proxy is not running');
    const listing = await ctx.docker.exec(PROXY_CONTAINER, ['find', CADDY_CERT_DIR, '-type', 'f', '-name', '*.crt'], 15_000);
    const stored = (listing.exitCode === 0 ? listing.stdout : '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith(`${CADDY_CERT_DIR}/`))
      .map((file) => {
        const [issuerDir, name, base, extra] = file.slice(CADDY_CERT_DIR.length + 1).split('/');
        return { file, issuerDir: issuerDir ?? '', name: name ?? '', ok: base === `${name}.crt` && extra === undefined };
      })
      .filter((f) => f.ok);
    // Only files of the apps' own domains and issuers, named as Caddy names them
    const wanted = stored.filter((f) =>
      fromCaddy.some(({ config, source }) => issuerMatches(source, f.issuerDir) && config.domains.some((d) => storageName(d) === f.name)),
    );
    const pems = new Map<string, string>();
    if (wanted.length > 0) {
      // The file names are arguments, never part of the script
      const read = await ctx.docker.exec(
        PROXY_CONTAINER,
        ['sh', '-c', 'for f in "$@"; do printf "\\n==> %s\\n" "$f"; cat -- "$f"; done', 'sh', ...wanted.slice(0, 500).map((f) => f.file)],
        30_000,
      );
      for (const part of read.stdout.split('\n==> ').slice(1)) {
        const nl = part.indexOf('\n');
        if (nl > 0) pems.set(part.slice(0, nl), part.slice(nl + 1));
      }
    }
    const errors = parseCaddyErrors(await ctx.docker.logsTail(PROXY_CONTAINER, LOG_LINES));
    for (const { app, config, source } of fromCaddy) {
      const facts = config.domains.map((domain) => {
        let best: CertInfo | null = null;
        for (const f of wanted.filter((x) => x.name === storageName(domain) && issuerMatches(source, x.issuerDir))) {
          const pem = pems.get(f.file);
          const info = pem ? parseCertificate(pem) : null;
          if (info && (!best || info.notAfter > best.notAfter)) best = info;
        }
        return certificateFor(domain, source, best, errors.get(domain) ?? null);
      });
      out.set(app, summarizeCertificate(facts, now));
    }
  } catch {
    for (const { app } of fromCaddy) out.set(app, null);
  }
  return out;
}
