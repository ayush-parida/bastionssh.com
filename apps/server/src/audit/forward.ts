import { createHmac } from 'crypto';
import dgram from 'dgram';
import http from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';
import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm';
import type { AuditForwardingInfo, AuditLogEntry, SyslogProtocol } from '@smt/shared';
import { getDb } from '../db/index.js';
import { auditForwarders, auditLog } from '../db/schema.js';
import { vault } from '../vault/index.js';
import { config } from '../config/index.js';
import logger from '../logger.js';
import { maskUrl } from '../notifications/format.js';
import { resolveSafeTarget, UnsafeTargetError, type ResolvedTarget } from '../net/ssrf.js';
import { auditSystem } from './index.js';

/**
 * Copies an org's new audit rows to one outside collector: syslog (RFC 5424,
 * over UDP, TCP or TLS with RFC 6587 octet-counting framing) or a webhook
 * (JSON batches, optionally HMAC-signed). Runs in-process on an interval, like
 * the health monitor. Delivery is at-least-once: the cursor only moves past
 * rows the target accepted, so a failed batch is sent again later.
 */

export type ForwarderConfig =
  | { type: 'syslog'; host: string; port: number; protocol: SyslogProtocol; facility: number; caCert?: string }
  | { type: 'webhook'; url: string; secret?: string };

export type ForwarderRow = typeof auditForwarders.$inferSelect;

/** Rows per syslog connection or webhook POST. */
export const BATCH_SIZE = 200;
/** Batches per forwarder per tick, so one large backlog cannot hog the loop. */
const MAX_BATCHES_PER_TICK = 10;
/** Attempts per batch within one tick, with a short pause between them. */
export const SEND_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 2_000];
/** After a batch fails every attempt, wait this long (doubling, capped) before the next try. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const TICK_MS = 10_000;
/**
 * Rows younger than this wait for a later tick. A row's created_at is set
 * before its insert waits for the write lock (up to 5 s by default, e.g. from
 * the worker process), so it can commit after a newer row; sending only rows
 * this old keeps the cursor from moving past one still on its way in.
 */
export const SETTLE_MS = 15_000;
const TIMEOUT_MS = 10_000;
/** UDP syslog: one datagram per row, kept under the practical IPv4 limit. */
const MAX_UDP_BYTES = 60_000;

export function vaultId(orgId: string): string {
  return `audit-forwarder:${orgId}`;
}

export async function encryptConfig(orgId: string, cfg: ForwarderConfig): Promise<string> {
  return vault.encrypt(JSON.stringify(cfg), vaultId(orgId));
}

export async function decryptConfig(row: Pick<ForwarderRow, 'orgId' | 'encryptedConfig'>): Promise<ForwarderConfig> {
  return JSON.parse(await vault.decrypt(row.encryptedConfig, vaultId(row.orgId))) as ForwarderConfig;
}

/** What the UI may show: never the webhook path or any secret. */
export function targetHint(cfg: ForwarderConfig): string {
  if (cfg.type === 'syslog') {
    const host = net.isIP(cfg.host) === 6 ? `[${cfg.host}]` : cfg.host;
    return `${cfg.protocol}://${host}:${cfg.port}`;
  }
  return maskUrl(cfg.url);
}

export async function toForwardingInfo(row: ForwarderRow): Promise<AuditForwardingInfo> {
  const cfg = await decryptConfig(row);
  return {
    type: cfg.type,
    enabled: row.enabled,
    targetHint: row.targetHint,
    ...(cfg.type === 'syslog'
      ? {
          syslog: {
            host: cfg.host,
            port: cfg.port,
            protocol: cfg.protocol,
            facility: cfg.facility,
            hasCaCert: !!cfg.caCert,
          },
        }
      : { webhook: { hasSecret: !!cfg.secret } }),
    lastStatus: (row.lastStatus as 'ok' | 'failed' | null) ?? null,
    lastError: row.lastError,
    lastSentAt: row.lastSentAt,
    updatedAt: row.updatedAt,
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

type AuditRow = typeof auditLog.$inferSelect;

export function toEntry(row: AuditRow): AuditLogEntry {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = { raw: row.metadata };
    }
  }
  return {
    id: row.id,
    orgId: row.orgId,
    actorId: row.actorId,
    actorEmail: row.actorEmail,
    action: row.action as AuditLogEntry['action'],
    resourceType: row.resourceType,
    ...(row.resourceId != null && { resourceId: row.resourceId }),
    ...(row.resourceName != null && { resourceName: row.resourceName }),
    ...(row.ipAddress != null && { ipAddress: row.ipAddress }),
    ...(row.userAgent != null && { userAgent: row.userAgent }),
    ...(metadata && { metadata }),
    createdAt: row.createdAt,
  };
}

/** Actions a collector should flag: someone being refused, or something changing under them. */
const WARNING_ACTIONS = /(login_failed|login_locked|mismatch|forwarding_failed)$/;

/** RFC 5424 severity: 4 (warning) for refusals and mismatches, 5 (notice) for the rest. */
export function syslogSeverity(action: string): number {
  return WARNING_ACTIONS.test(action) ? 4 : 5;
}

/** PRINTUSASCII without the characters an SD-NAME or header field may not hold. */
function headerToken(s: string, max: number): string {
  const cleaned = s.replace(/[^\x21-\x7e]/g, '_').slice(0, max);
  return cleaned || '-';
}

function sdEscape(s: string): string {
  return s.replace(/["\\\]]/g, (c) => `\\${c}`);
}

/** The IANA example enterprise number; the SD-ID is namespaced, not registered. */
const SD_ID = 'bastionssh@32473';
const APP_NAME = 'bastionssh';

function localHostname(): string {
  try {
    return new URL(config.baseUrl).hostname || '-';
  } catch {
    return '-';
  }
}

/**
 * One audit row as an RFC 5424 message: the headline fields go in structured
 * data a collector can index, the whole row as JSON in MSG (after a BOM, which
 * marks it as UTF-8).
 */
export function formatSyslog(entry: AuditLogEntry, facility: number, hostname = localHostname()): string {
  const pri = facility * 8 + syslogSeverity(entry.action);
  const params: [string, string | undefined][] = [
    ['org', entry.orgId],
    ['actor', entry.actorEmail],
    ['action', entry.action],
    ['resourceType', entry.resourceType],
    ['resourceId', entry.resourceId],
    ['ip', entry.ipAddress],
  ];
  const sd = `[${SD_ID} ${params
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}="${sdEscape(v!)}"`)
    .join(' ')}]`;
  const header = [
    `<${pri}>1`,
    entry.createdAt,
    headerToken(hostname, 255),
    APP_NAME,
    '-',
    headerToken(entry.action, 32),
  ].join(' ');
  return `${header} ${sd} \uFEFF${JSON.stringify(entry)}`;
}

/** RFC 6587 octet counting: the byte length, a space, then the message. */
export function frameOctetCounted(message: string): Buffer {
  const body = Buffer.from(message, 'utf8');
  return Buffer.concat([Buffer.from(`${body.length} `, 'ascii'), body]);
}

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

// ── Transports ───────────────────────────────────────────────────────────────

export interface SendOptions {
  /** Resolve and SSRF-check a hostname; tests substitute their own. */
  resolve?: (host: string) => Promise<ResolvedTarget>;
}

function resolver(opts: SendOptions) {
  return opts.resolve ?? ((host: string) => resolveSafeTarget(host));
}

async function sendUdp(target: ResolvedTarget, port: number, messages: string[]): Promise<void> {
  const socket = dgram.createSocket(target.family === 6 ? 'udp6' : 'udp4');
  try {
    for (const m of messages) {
      let buf = Buffer.from(m, 'utf8');
      if (buf.length > MAX_UDP_BYTES) buf = buf.subarray(0, MAX_UDP_BYTES);
      await new Promise<void>((resolve, reject) => {
        socket.send(buf, port, target.address, (err) => (err ? reject(err) : resolve()));
      });
    }
  } finally {
    socket.close();
  }
}

async function sendStream(
  cfg: Extract<ForwarderConfig, { type: 'syslog' }>,
  target: ResolvedTarget,
  messages: string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket =
      cfg.protocol === 'tls'
        ? tls.connect({
            host: target.address,
            port: cfg.port,
            // Verify the certificate against the name the owner typed, not the address
            servername: net.isIP(cfg.host) ? undefined : cfg.host,
            ...(net.isIP(cfg.host) && { checkServerIdentity: (_h, cert) => tls.checkServerIdentity(cfg.host, cert) }),
            ...(cfg.caCert && { ca: cfg.caCert }),
            rejectUnauthorized: true,
          })
        : net.connect({ host: target.address, port: cfg.port });
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(TIMEOUT_MS, () => done(new Error(`Timed out talking to ${cfg.host}:${cfg.port}`)));
    socket.once('error', (err) => done(err));
    socket.once(cfg.protocol === 'tls' ? 'secureConnect' : 'connect', () => {
      const payload = Buffer.concat(messages.map(frameOctetCounted));
      socket.end(payload, () => done());
    });
  });
}

async function sendWebhook(
  cfg: Extract<ForwarderConfig, { type: 'webhook' }>,
  target: ResolvedTarget,
  payload: unknown,
): Promise<void> {
  const url = new URL(cfg.url);
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'user-agent': 'BastionSSH-AuditForwarder/1',
    'x-bastionssh-timestamp': timestamp,
  };
  if (cfg.secret) headers['x-bastionssh-signature'] = signWebhook(cfg.secret, timestamp, body);
  if (url.username || url.password) {
    headers.authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`;
  }
  const mod = url.protocol === 'https:' ? https : http;
  await new Promise<void>((resolve, reject) => {
    const req = mod.request(
      {
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[(.*)\]$/, '$1'),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers,
        timeout: TIMEOUT_MS,
        // Pin the connection to the address that passed the SSRF check, so a
        // DNS answer that changes in between cannot redirect it. The Host
        // header and TLS name stay the hostname.
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
          if (opts?.all) cb(null, [{ address: target.address, family: target.family }]);
          else cb(null, target.address, target.family);
        }) as unknown as net.LookupFunction,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        // Redirects are not followed: the new location has not been checked
        if (status >= 200 && status < 300) resolve();
        else reject(new Error(`Webhook answered HTTP ${status}`));
      },
    );
    req.on('timeout', () => req.destroy(new Error('Webhook timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Deliver entries once to the target, SSRF check included. Throws on any failure. */
export async function deliver(cfg: ForwarderConfig, entries: AuditLogEntry[], opts: SendOptions = {}): Promise<void> {
  if (cfg.type === 'syslog') {
    const target = await resolver(opts)(cfg.host);
    const messages = entries.map((e) => formatSyslog(e, cfg.facility));
    if (cfg.protocol === 'udp') await sendUdp(target, cfg.port, messages);
    else await sendStream(cfg, target, messages);
    return;
  }
  const url = new URL(cfg.url);
  const target = await resolver(opts)(url.hostname);
  // Audit rows carry emails and IPs: plain HTTP only inside an allowed internal network
  if (url.protocol === 'http:' && !target.internal) {
    throw new UnsafeTargetError('Webhook URLs must use https unless they point into SMT_AUDIT_FORWARD_ALLOW_NETS');
  }
  await sendWebhook(cfg, target, { source: APP_NAME, events: entries });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** {@link deliver} with retries. An unsafe target is not retried: it will not become safe. */
export async function deliverWithRetry(
  cfg: ForwarderConfig,
  entries: AuditLogEntry[],
  opts: SendOptions & { delays?: number[] } = {},
): Promise<void> {
  const delays = opts.delays ?? RETRY_DELAYS_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt++) {
    try {
      await deliver(cfg, entries, opts);
      return;
    } catch (err) {
      lastErr = err;
      if (err instanceof UnsafeTargetError) break;
      if (attempt < SEND_ATTEMPTS - 1) await sleep(delays[attempt] ?? delays[delays.length - 1] ?? 0);
    }
  }
  throw lastErr;
}

/** A short, secret-free reason for the UI: never echo a URL, which may carry a token. */
export function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/https?:\/\/\S+/g, '[url]').slice(0, 300);
}

// ── Delivery loop ────────────────────────────────────────────────────────────

/** Rows after the cursor and no newer than `settledBefore`, oldest first. rowid breaks ties between equal timestamps. */
function pendingRows(row: ForwarderRow, settledBefore: string) {
  return getDb()
    .select({ entry: auditLog, rowid: sql<number>`${auditLog}.rowid`.as('rid') })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.orgId, row.orgId),
        lte(auditLog.createdAt, settledBefore),
        or(
          gt(auditLog.createdAt, row.cursorCreatedAt),
          and(eq(auditLog.createdAt, row.cursorCreatedAt), gt(sql`${auditLog}.rowid`, row.cursorRowid)),
        ),
      ),
    )
    .orderBy(asc(auditLog.createdAt), asc(sql`${auditLog}.rowid`))
    .limit(BATCH_SIZE)
    .all();
}

/** Where a new forwarder starts: after everything already in the log, so history is not replayed. */
export function currentCursor(orgId: string): { cursorCreatedAt: string; cursorRowid: number } {
  const last = getDb()
    .select({ createdAt: auditLog.createdAt, rowid: sql<number>`${auditLog}.rowid` })
    .from(auditLog)
    .where(eq(auditLog.orgId, orgId))
    .orderBy(sql`${auditLog.createdAt} desc`, sql`${auditLog}.rowid desc`)
    .limit(1)
    .get();
  return last ? { cursorCreatedAt: last.createdAt, cursorRowid: last.rowid } : { cursorCreatedAt: '', cursorRowid: 0 };
}

/** Per-org backoff after a batch failed every attempt. In memory: a restart just tries again. */
const backoff = new Map<string, { failures: number; until: number }>();

export function resetBackoff(orgId?: string) {
  if (orgId) backoff.delete(orgId);
  else backoff.clear();
}

/**
 * Send one forwarder's pending rows. Returns how many were delivered. On
 * failure the cursor stays put, the error is recorded on the row, and the org
 * backs off; the first failure after a success is itself audited.
 */
export async function forwardOrg(
  orgId: string,
  opts: SendOptions & { delays?: number[]; now?: number; settleMs?: number } = {},
): Promise<number> {
  const db = getDb();
  const now = opts.now ?? Date.now();
  const settledBefore = new Date(now - (opts.settleMs ?? SETTLE_MS)).toISOString();
  const wait = backoff.get(orgId);
  if (wait && now < wait.until) return 0;

  let sent = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    // Re-read each batch: the owner may have changed or removed it meanwhile
    const row = db.select().from(auditForwarders).where(eq(auditForwarders.orgId, orgId)).get();
    if (!row?.enabled) return sent;
    const pending = pendingRows(row, settledBefore);
    if (!pending.length) break;

    try {
      const cfg = await decryptConfig(row);
      await deliverWithRetry(cfg, pending.map((p) => toEntry(p.entry)), opts);
    } catch (err) {
      const failures = (wait?.failures ?? 0) + 1;
      backoff.set(orgId, { failures, until: now + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS) });
      const reason = describeError(err);
      db.update(auditForwarders)
        .set({ lastStatus: 'failed', lastError: reason })
        .where(eq(auditForwarders.orgId, orgId))
        .run();
      if (row.lastStatus !== 'failed') {
        logger.warn({ orgId, err: reason }, 'Audit forwarding failed');
        auditSystem(orgId, 'audit.forwarding_failed', 'audit_forwarder', orgId, row.targetHint, { error: reason });
      }
      return sent;
    }

    const last = pending[pending.length - 1]!;
    // Only move the cursor if the target was not swapped out while we sent
    db.update(auditForwarders)
      .set({
        cursorCreatedAt: last.entry.createdAt,
        cursorRowid: last.rowid,
        lastStatus: 'ok',
        lastError: null,
        lastSentAt: new Date().toISOString(),
      })
      .where(and(eq(auditForwarders.orgId, orgId), eq(auditForwarders.encryptedConfig, row.encryptedConfig)))
      .run();
    backoff.delete(orgId);
    sent += pending.length;
    if (pending.length < BATCH_SIZE) break;
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function runForwardSweep(): Promise<void> {
  const orgs = getDb()
    .select({ orgId: auditForwarders.orgId })
    .from(auditForwarders)
    .where(eq(auditForwarders.enabled, true))
    .all();
  for (const { orgId } of orgs) {
    try {
      await forwardOrg(orgId);
    } catch (err) {
      logger.error({ err, orgId }, 'Audit forwarding sweep failed for org');
    }
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await runForwardSweep();
  } catch (err) {
    logger.error({ err }, 'Audit forwarding sweep failed');
  } finally {
    running = false;
  }
}

export function startAuditForwarding() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
}

export function stopAuditForwarding() {
  if (timer) clearInterval(timer);
  timer = null;
}
