import dns, { type LookupAddress } from 'node:dns';
import net, { isIP, type Socket } from 'node:net';
import tls, { type ConnectionOptions, type TLSSocket } from 'node:tls';
import type { DiagnosticStep, HostKeyScanResult } from '@smt/shared';
import { scanHostKey } from '../ssh/host-keys.js';
import type { DiagnosticService } from './remediation.js';

/**
 * The individual probes behind connectivity diagnostics. Each one answers a
 * single question — does the name resolve, does the port answer, does the
 * thing on the port speak the expected protocol, is it the host we pinned —
 * and never throws: a failure is an outcome with a plain-words explanation.
 *
 * Network access goes through {@link DiagnosticsDeps} so every outcome can be
 * tested without a real resolver or socket.
 */

export interface DiagnosticsDeps {
  /** getaddrinfo — the same resolution a real connection uses (hosts file included). */
  lookup(host: string): Promise<LookupAddress[]>;
  /** A direct DNS A query, only to tell NXDOMAIN from "exists but has no address". */
  resolve4(host: string): Promise<string[]>;
  connect(address: string, port: number): Socket;
  tlsConnect(options: ConnectionOptions): TLSSocket;
  scanHostKey(host: string, port: number, timeoutMs: number, preferType?: string | null): Promise<HostKeyScanResult>;
}

export const defaultDeps: DiagnosticsDeps = {
  lookup: (host) => dns.promises.lookup(host, { all: true, verbatim: true }),
  resolve4: (host) => new dns.promises.Resolver({ timeout: 3_000, tries: 1 }).resolve4(host),
  connect: (address, port) => net.connect({ host: address, port }),
  tlsConnect: (options) => tls.connect(options),
  scanHostKey: (host, port, timeoutMs, preferType) => scanHostKey(host, port, timeoutMs, preferType),
};

/** Per-step budgets. Generous enough for a slow link, short enough to finish well inside a minute. */
export const STEP_TIMEOUTS = {
  dns: 5_000,
  tcp: 8_000,
  banner: 8_000,
  tls: 8_000,
  hostKey: 10_000,
  auth: 25_000,
  docker: 45_000,
} as const;

export type StepOutcome = Pick<DiagnosticStep, 'status' | 'detail' | 'remediation' | 'data'>;

export class StepTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms`);
    this.name = 'StepTimeoutError';
  }
}

/** Reject with {@link StepTimeoutError} when `promise` has not settled in time. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StepTimeoutError(timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

/** A server's own words, made safe to show: printable ASCII only, capped. */
export function printable(text: string, max = 160): string {
  const clean = text.replace(/[^\x20-\x7e]/g, '?').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function errCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

// ── DNS ─────────────────────────────────────────────────────────────────────

/** Cloud metadata services: a stored hostname must not become a way to reach them. */
const BLOCKED_ADDRESSES = new Set(['169.254.169.254', 'fd00:ec2::254']);

export interface DnsResult {
  outcome: StepOutcome;
  /** Resolved addresses, IPv4 first; empty when resolution failed. */
  addresses: string[];
}

export async function checkDns(
  host: string,
  deps: DiagnosticsDeps,
  timeoutMs: number = STEP_TIMEOUTS.dns,
): Promise<DnsResult> {
  if (isIP(host)) {
    if (BLOCKED_ADDRESSES.has(host)) {
      return { addresses: [], outcome: { status: 'fail', detail: 'That address is not allowed.' } };
    }
    return {
      addresses: [host],
      outcome: { status: 'ok', detail: `${host} is an IP address — no DNS lookup needed.`, data: { a: isIP(host) === 4 ? [host] : [], aaaa: isIP(host) === 6 ? [host] : [] } },
    };
  }

  let results: LookupAddress[];
  try {
    results = await withTimeout(deps.lookup(host), timeoutMs);
  } catch (err) {
    return { addresses: [], outcome: await dnsFailure(host, err, deps) };
  }

  const a = [...new Set(results.filter((r) => r.family === 4).map((r) => r.address))];
  const aaaa = [...new Set(results.filter((r) => r.family === 6).map((r) => r.address))];
  const addresses = [...a, ...aaaa];
  if (addresses.some((address) => BLOCKED_ADDRESSES.has(address))) {
    return {
      addresses: [],
      outcome: { status: 'fail', detail: `${host} resolves to an address that is not allowed.` },
    };
  }
  if (addresses.length === 0) {
    return {
      addresses: [],
      outcome: {
        status: 'fail',
        detail: `${host} has no A or AAAA record.`,
        remediation: `Add an A record for ${host} pointing at the server’s IP address.`,
      },
    };
  }

  const parts = [
    ...(a.length ? [`${a.join(', ')} (A)`] : []),
    ...(aaaa.length ? [`${aaaa.join(', ')} (AAAA)`] : []),
  ];
  return {
    addresses,
    outcome: {
      // IPv6 only is fine for the host, but many container networks cannot route it
      status: a.length === 0 ? 'warn' : 'ok',
      detail:
        `${host} resolves to ${parts.join('; ')}.` +
        (a.length === 0 ? ' It has no IPv4 address, and many Docker networks cannot reach IPv6.' : ''),
      ...(a.length === 0 && {
        remediation: `Add an A record for ${host}, or enable IPv6 on the network BastionSSH runs in.`,
      }),
      data: { a, aaaa },
    },
  };
}

async function dnsFailure(host: string, err: unknown, deps: DiagnosticsDeps): Promise<StepOutcome> {
  const code = err instanceof StepTimeoutError ? 'ETIMEOUT' : errCode(err);

  if (code === 'ENOTFOUND' || code === 'ENODATA') {
    // getaddrinfo reports "no such name" and "no address" alike; ask DNS directly to tell them apart
    let direct: string | undefined;
    try {
      await deps.resolve4(host);
      direct = 'found';
    } catch (e) {
      direct = errCode(e);
    }
    if (direct === 'ENOTFOUND') {
      return {
        status: 'fail',
        detail: `NXDOMAIN: ${host} does not exist in DNS.`,
        remediation: `Check the spelling of ${host}. If it is new, create its A record at your DNS provider and wait for it to propagate.`,
        data: { code: 'NXDOMAIN' },
      };
    }
    if (direct === 'ENODATA') {
      return {
        status: 'fail',
        detail: `${host} exists in DNS but has no A or AAAA record.`,
        remediation: `Add an A record for ${host} pointing at the server’s IP address.`,
        data: { code: 'NODATA' },
      };
    }
    return {
      status: 'fail',
      detail: `${host} could not be resolved (${code}).`,
      remediation: `Check the spelling of ${host} and that it has an A record. Names only known on your LAN or VPN also need a resolver that knows them.`,
      data: { code },
    };
  }

  if (code === 'EAI_AGAIN' || code === 'ETIMEOUT' || code === 'ESERVFAIL' || code === 'ECONNREFUSED') {
    return {
      status: 'fail',
      detail:
        code === 'ETIMEOUT'
          ? `DNS lookup for ${host} did not answer in time.`
          : `DNS lookup for ${host} failed temporarily (${code}) — the resolver could not be reached or gave no answer.`,
      remediation:
        'Check the DNS resolver this app uses (/etc/resolv.conf inside the container) and that outbound DNS (UDP/TCP 53) is allowed. Retry in a minute.',
      data: { code },
    };
  }

  return {
    status: 'fail',
    detail: `DNS lookup for ${host} failed: ${(err as Error)?.message ?? String(err)}`,
    data: { code },
  };
}

/** Prefer IPv4: it is what firewall rules and security groups are usually written for. */
export function pickAddress(addresses: string[]): string | undefined {
  return addresses.find((a) => isIP(a) === 4) ?? addresses[0];
}

// ── TCP ─────────────────────────────────────────────────────────────────────

export type TcpKind = 'connected' | 'refused' | 'filtered' | 'unreachable' | 'error';

export interface TcpResult {
  kind: TcpKind;
  outcome: StepOutcome;
  /** The open socket, for the protocol steps; only when connected. The caller must destroy it. */
  socket?: Socket;
}

export function checkTcp(
  address: string,
  port: number,
  deps: DiagnosticsDeps,
  timeoutMs: number = STEP_TIMEOUTS.tcp,
): Promise<TcpResult> {
  const where = `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
  return new Promise((resolve) => {
    let settled = false;
    let socket: Socket;
    const finish = (result: TcpResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const data = (kind: TcpKind, extra: Record<string, unknown> = {}) => ({ address, port, outcome: kind, ...extra });

    const timer = setTimeout(() => {
      socket?.destroy();
      finish({
        kind: 'filtered',
        outcome: {
          status: 'fail',
          detail: `No answer from ${where} within ${seconds(timeoutMs)}. The packets are being dropped — the port is filtered by a firewall or cloud security group — or the host is down.`,
          data: data('filtered'),
        },
      });
    }, timeoutMs);

    const onError = (err: Error) => {
      socket.destroy();
      const code = errCode(err);
      if (code === 'ECONNREFUSED') {
        return finish({
          kind: 'refused',
          outcome: {
            status: 'fail',
            detail: `Connection refused by ${where}: the host is up, but nothing accepts connections on TCP ${port} (or a firewall rejects them).`,
            data: data('refused', { code }),
          },
        });
      }
      if (code === 'ETIMEDOUT') {
        return finish({
          kind: 'filtered',
          outcome: {
            status: 'fail',
            detail: `Connecting to ${where} timed out. The port is filtered by a firewall or cloud security group, or the host is down.`,
            data: data('filtered', { code }),
          },
        });
      }
      if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL' || code === 'EHOSTDOWN') {
        return finish({
          kind: 'unreachable',
          outcome: {
            status: 'fail',
            detail: `${address} is unreachable from this app (${code}): there is no route to it.`,
            data: data('unreachable', { code }),
          },
        });
      }
      finish({
        kind: 'error',
        outcome: {
          status: 'fail',
          detail: `Could not connect to ${where}: ${err.message}`,
          data: data('error', { code }),
        },
      });
    };

    try {
      socket = deps.connect(address, port);
    } catch (err) {
      return onError(err as Error);
    }
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      // Later steps attach their own handlers; never let a late error go unhandled
      socket.on('error', () => {});
      finish({
        kind: 'connected',
        socket,
        outcome: { status: 'ok', detail: `Connected to ${where}.`, data: data('connected') },
      });
    });
  });
}

// ── Reading what the server says ─────────────────────────────────────────────

const MAX_READ_BYTES = 8_192;

export interface ReadResult {
  text: string;
  /** Why reading stopped. */
  ended: 'match' | 'closed' | 'timeout' | 'error' | 'overflow';
  error?: Error;
}

/** Collect what the peer sends until `until` is satisfied, it hangs up, or time runs out. */
export function readUntil(
  socket: Socket,
  until: (text: string) => boolean,
  timeoutMs: number,
): Promise<ReadResult> {
  return new Promise((resolve) => {
    let text = '';
    let settled = false;
    const finish = (ended: ReadResult['ended'], error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('end', onClose);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      resolve({ text, ended, ...(error && { error }) });
    };
    const onData = (chunk: Buffer | string) => {
      text += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
      if (until(text)) finish('match');
      else if (text.length > MAX_READ_BYTES) finish('overflow');
    };
    const onClose = () => finish('closed');
    const onError = (err: Error) => finish('error', err);
    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    socket.on('data', onData);
    socket.once('end', onClose);
    socket.once('close', onClose);
    socket.once('error', onError);
    // A peer that already spoke before we listened (and nothing more is coming)
    if (until(text)) finish('match');
  });
}

function firstLine(text: string): string {
  return printable(text.split(/\r?\n/)[0] ?? '');
}

/** What the first bytes on a port suggest is really listening there. */
export function guessProtocol(text: string): string | null {
  if (/^SSH-/.test(text)) return 'an SSH server';
  if (/^\d{3}[ -]/.test(text)) return 'an FTP (or mail) server';
  if (/^HTTP\/\d/i.test(text)) return 'a web server';
  // A TLS record header: alert (0x15) or handshake (0x16), then version 3.x
  // eslint-disable-next-line no-control-regex
  if (/^\x15\x03/.test(text) || /^\x16\x03/.test(text)) return 'a TLS service';
  return null;
}

// ── SSH banner ───────────────────────────────────────────────────────────────

/**
 * RFC 4253 §4.2: the server sends `SSH-protoversion-softwareversion` first; it
 * may precede it with other lines, which clients must ignore.
 */
const SSH_BANNER = /(?:^|\n)(SSH-[^\r\n]*)\r?\n/;

export async function checkSshBanner(
  socket: Socket,
  timeoutMs: number = STEP_TIMEOUTS.banner,
): Promise<StepOutcome> {
  // Lines before the banner are allowed, but a first line that is plainly
  // another protocol's greeting will not be followed by one
  const read = await readUntil(
    socket,
    (text) => SSH_BANNER.test(text) || (/\n/.test(text) && guessProtocol(text) !== null),
    timeoutMs,
  );
  const match = SSH_BANNER.exec(read.text);
  if (match) {
    const banner = printable(match[1]!);
    if (/^SSH-1\.(?!99)/.test(banner)) {
      return {
        status: 'fail',
        detail: `The server only speaks SSH protocol 1 (${banner}), which is insecure and not supported.`,
        remediation: 'Upgrade the SSH server to one that speaks protocol 2.',
        data: { banner },
      };
    }
    return { status: 'ok', detail: `The server identifies as ${banner}.`, data: { banner } };
  }
  return noBanner(read, 'SSH', {
    wrongProtocol: 'Check the port — this is not the SSH port. SSH usually listens on 22.',
    closed:
      'Common causes: sshd is throttling unauthenticated connections (MaxStartups), TCP wrappers (/etc/hosts.deny), ' +
      'or fail2ban/sshguard has banned this app’s IP. Check the server’s auth log: sudo journalctl -u ssh -n 50.',
    silent:
      'Something accepts TCP on this port but does not speak SSH — often a load balancer or NAT rule with no healthy backend, or a service other than sshd.',
  });
}

const EXPECTED_FIRST_WORDS = {
  SSH: 'an SSH banner',
  FTP: 'an FTP greeting',
  HTTP: 'an HTTP response',
} as const;

function noBanner(
  read: ReadResult,
  expected: keyof typeof EXPECTED_FIRST_WORDS,
  hints: { wrongProtocol: string; closed: string; silent: string },
): StepOutcome {
  const seen = firstLine(read.text);
  if (seen) {
    const guess = guessProtocol(read.text);
    return {
      status: 'fail',
      detail: `The port answered, but not with ${expected}${guess ? ` — it looks like ${guess}` : ''}: “${seen}”.`,
      remediation: hints.wrongProtocol,
      data: { received: seen },
    };
  }
  if (read.ended === 'timeout') {
    return {
      status: 'fail',
      detail: `Connected, but the server sent nothing within the time allowed.`,
      remediation: hints.silent,
    };
  }
  return {
    status: 'fail',
    detail: `The server closed the connection without sending ${EXPECTED_FIRST_WORDS[expected]}${read.error ? ` (${read.error.message})` : ''}.`,
    remediation: hints.closed,
  };
}

// ── FTP greeting ─────────────────────────────────────────────────────────────

export interface FtpReply {
  code: number;
  text: string;
}

/** A complete FTP reply at the start of `text` (single or multi-line), or null. */
export function parseFtpReply(text: string): FtpReply | null {
  const lines = text.split(/\r?\n/);
  const first = /^(\d{3})([ -])/.exec(lines[0] ?? '');
  if (!first) return null;
  const code = first[1]!;
  // A single-line reply needs its line ending to be complete
  if (first[2] === ' ') return lines.length > 1 ? { code: Number(code), text: printable(lines[0]!) } : null;
  const end = lines.findIndex((line, i) => i > 0 && line.startsWith(`${code} `));
  if (end === -1 || end === lines.length - 1) return null;
  return { code: Number(code), text: printable(lines.slice(0, end + 1).join(' ')) };
}

export async function checkFtpGreeting(
  socket: Socket,
  implicitTls: boolean,
  timeoutMs: number = STEP_TIMEOUTS.banner,
): Promise<StepOutcome> {
  const read = await readUntil(socket, (text) => parseFtpReply(text) !== null || /^SSH-[^\n]*\n/.test(text), timeoutMs);
  const reply = parseFtpReply(read.text);
  if (reply) {
    if (reply.code === 220) {
      return { status: 'ok', detail: `The server greeted: ${reply.text}`, data: { code: reply.code, greeting: reply.text } };
    }
    if (reply.code === 120) {
      return {
        status: 'warn',
        detail: `The server is not ready yet: ${reply.text}`,
        remediation: 'Retry once the server says it is ready.',
        data: { code: reply.code, greeting: reply.text },
      };
    }
    if (reply.code === 421) {
      return {
        status: 'fail',
        detail: `The server refused the session: ${reply.text}`,
        remediation:
          'It has too many connections, or it limits or blocks this app’s IP (per-IP connection limits, fail2ban). Check the FTP server’s connection limits and ban list.',
        data: { code: reply.code, greeting: reply.text },
      };
    }
    return {
      status: 'fail',
      detail: `Unexpected greeting: ${reply.text}`,
      data: { code: reply.code, greeting: reply.text },
    };
  }
  if (/^SSH-/.test(read.text)) {
    return {
      status: 'fail',
      detail: `This port speaks SSH (${firstLine(read.text)}), not FTP.`,
      remediation: 'Change the connection’s protocol to SFTP.',
      data: { received: firstLine(read.text) },
    };
  }
  return noBanner(read, 'FTP', {
    wrongProtocol: 'Check the port and protocol: FTP and explicit FTPS usually listen on 21, implicit FTPS on 990.',
    closed: 'The server may limit connections per IP or have banned this app’s IP; check its connection limits and logs.',
    silent: implicitTls
      ? 'The server may expect plain FTP here — try FTPS (explicit) on port 21.'
      : 'Servers on port 990 wait for a TLS handshake before greeting — if this is implicit FTPS, choose “FTPS (implicit)”.',
  });
}

/** Explicit FTPS: ask to upgrade the control connection. */
export async function requestAuthTls(
  socket: Socket,
  timeoutMs: number = STEP_TIMEOUTS.tls,
): Promise<{ ok: true } | { ok: false; outcome: StepOutcome }> {
  socket.write('AUTH TLS\r\n');
  const read = await readUntil(socket, (text) => parseFtpReply(text) !== null, timeoutMs);
  const reply = parseFtpReply(read.text);
  if (reply?.code === 234) return { ok: true };
  return {
    ok: false,
    outcome: reply
      ? {
          status: 'fail',
          detail: `The server does not offer explicit TLS: AUTH TLS was answered with “${reply.text}”.`,
          remediation:
            'Enable TLS on the FTP server, or choose implicit FTPS (port 990) if that is what it offers. Plain FTP sends the password unencrypted.',
          data: { code: reply.code },
        }
      : { status: 'fail', detail: 'The server did not answer AUTH TLS in time.' },
  };
}

// ── TLS ─────────────────────────────────────────────────────────────────────

export interface TlsResult {
  outcome: StepOutcome;
  socket?: TLSSocket;
}

/** Days until the certificate expires; negative once it has. */
export function daysUntil(validTo: string, now = Date.now()): number | null {
  const at = Date.parse(validTo);
  if (Number.isNaN(at)) return null;
  return Math.floor((at - now) / 86_400_000);
}

function certName(fields: Record<string, unknown> | undefined): string | null {
  if (!fields) return null;
  const pick = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const cn = pick(fields.CN);
  const o = pick(fields.O);
  return typeof cn === 'string' ? cn : typeof o === 'string' ? o : null;
}

/**
 * Handshake over an already-open socket and judge the certificate ourselves, so
 * an untrusted one is reported with its reason instead of just "failed". The
 * hostname check is Node's own (it runs whether or not we reject).
 */
export function checkTls(
  opts: { socket: Socket; host: string; service: DiagnosticService; verify: boolean },
  deps: DiagnosticsDeps,
  timeoutMs: number = STEP_TIMEOUTS.tls,
): Promise<TlsResult> {
  const { socket, host, service, verify } = opts;
  return new Promise((resolve) => {
    let settled = false;
    let secure: TLSSocket;
    const finish = (result: TlsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const wrongPort =
      service === 'ftps-implicit'
        ? 'The port may not speak implicit TLS. FTP servers on port 21 usually want FTPS (explicit) instead.'
        : service === 'https'
          ? 'The port may not speak TLS — check whether the endpoint should be http:// rather than https://, and its port.'
          : 'Check that TLS is enabled on the server and that the port is right.';

    const timer = setTimeout(() => {
      secure?.destroy();
      finish({
        outcome: {
          status: 'fail',
          detail: `The TLS handshake did not finish within ${seconds(timeoutMs)}.`,
          remediation: wrongPort,
        },
      });
    }, timeoutMs);

    try {
      secure = deps.tlsConnect({
        socket,
        host,
        ...(isIP(host) === 0 && { servername: host }),
        // Judged below, so the reason can be reported rather than just refused
        rejectUnauthorized: false,
      });
    } catch (err) {
      finish({ outcome: { status: 'fail', detail: `TLS handshake failed: ${(err as Error).message}`, remediation: wrongPort } });
      return;
    }

    secure.once('error', (err: Error) => {
      finish({
        outcome: {
          status: 'fail',
          detail: `TLS handshake failed: ${err.message}`,
          remediation: wrongPort,
          data: { code: errCode(err) },
        },
      });
    });

    secure.once('secureConnect', () => {
      secure.on('error', () => {});
      const cert = secure.getPeerCertificate();
      const protocol = secure.getProtocol() ?? 'TLS';
      const subject = certName(cert?.subject as unknown as Record<string, unknown>);
      const issuer = certName(cert?.issuer as unknown as Record<string, unknown>);
      const days = cert?.valid_to ? daysUntil(cert.valid_to) : null;
      const data = {
        protocol,
        subject,
        issuer,
        validTo: cert?.valid_to ?? null,
        authorized: secure.authorized,
        ...(secure.authorizationError && { authorizationError: String(secure.authorizationError) }),
      };
      const described =
        `${protocol}, certificate for ${subject ?? 'an unnamed subject'}` +
        `${issuer ? ` issued by ${issuer}` : ''}${cert?.valid_to ? `, valid until ${cert.valid_to}` : ''}`;

      if (!secure.authorized) {
        const reason = String(secure.authorizationError ?? 'unknown reason');
        const fix =
          service === 'https'
            ? `Install a certificate from a trusted CA that covers ${host}, or use the endpoint’s correct hostname.`
            : `Install a certificate from a trusted CA that covers ${host}, or untick “Verify TLS certificate” on the connection if you trust this one.`;
        return finish({
          socket: secure,
          outcome: verify
            ? { status: 'fail', detail: `The certificate is not trusted (${reason}): ${described}.`, remediation: fix, data }
            : {
                status: 'warn',
                detail: `The certificate is not trusted (${reason}), which is accepted because certificate verification is off for this connection: ${described}.`,
                data,
              },
        });
      }
      if (days !== null && days < 14) {
        return finish({
          socket: secure,
          outcome: {
            status: 'warn',
            detail: `${described}. The certificate expires in ${days} day${days === 1 ? '' : 's'}.`,
            remediation: 'Renew the certificate before it expires.',
            data,
          },
        });
      }
      finish({ socket: secure, outcome: { status: 'ok', detail: `${described}.`, data } });
    });
  });
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/** A HEAD request is enough to prove an HTTP service is behind the port; any status counts. */
export async function checkHttpResponse(
  socket: Socket,
  hostHeader: string,
  timeoutMs: number = STEP_TIMEOUTS.banner,
): Promise<StepOutcome> {
  socket.write(
    `HEAD / HTTP/1.1\r\nHost: ${hostHeader}\r\nUser-Agent: BastionSSH-diagnostics\r\nConnection: close\r\n\r\n`,
  );
  const read = await readUntil(
    socket,
    // Headers complete — or a first line that is not a status line, so none are coming
    (text) => text.includes('\r\n\r\n') || (/\n/.test(text) && !/^HTTP\//i.test(text)),
    timeoutMs,
  );
  const status = /^HTTP\/\d(?:\.\d)? (\d{3})([^\r\n]*)/.exec(read.text);
  if (status) {
    const code = Number(status[1]);
    const server = /\r\nserver:\s*([^\r\n]+)/i.exec(read.text)?.[1];
    const line = printable(`HTTP ${code}${status[2]}`);
    const detail = `The endpoint answered ${line}${server ? ` (server: ${printable(server, 60)})` : ''}.`;
    if (code >= 500) {
      return {
        status: 'warn',
        detail: `${detail} The service is up but reports an error.`,
        remediation: 'Check the storage service’s own logs and health.',
        data: { status: code },
      };
    }
    return { status: 'ok', detail, data: { status: code } };
  }
  return noBanner(read, 'HTTP', {
    wrongProtocol: 'Check the endpoint URL’s scheme and port.',
    closed: 'Check the endpoint URL’s scheme (http vs https) and port.',
    silent: 'Check the endpoint URL’s scheme (http vs https) and port.',
  });
}

// ── Host key ─────────────────────────────────────────────────────────────────

/**
 * Read the key the host presents — without authenticating and without storing
 * anything — and compare it with the pinned one.
 */
export async function checkHostKeyPin(
  opts: { host: string; port: number; pinned: string | null; pinnedType?: string | null; revealPresented: boolean },
  deps: DiagnosticsDeps,
  timeoutMs: number = STEP_TIMEOUTS.hostKey,
): Promise<StepOutcome> {
  let presented: HostKeyScanResult;
  try {
    // Ask for the pinned key's type first, like a real connection: a host with
    // several key types would otherwise present another one and look "changed"
    presented = await deps.scanHostKey(opts.host, opts.port, timeoutMs, opts.pinned ? opts.pinnedType : null);
  } catch (err) {
    return {
      status: 'fail',
      detail: (err as Error).message,
      remediation: 'The SSH handshake did not get as far as the host key; see the banner step.',
    };
  }
  const key = `${presented.type} ${presented.fingerprint}`;
  if (!opts.pinned) {
    return {
      status: 'warn',
      detail: `The host presents ${key}. No key is pinned yet, so the first connection will trust it.`,
      remediation: 'Compare it with ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub on the server, then pin it from the host key panel.',
      data: { presented: presented.fingerprint, type: presented.type },
    };
  }
  if (presented.fingerprint === opts.pinned) {
    return {
      status: 'ok',
      detail: `The host presents the pinned key (${key}).`,
      data: { presented: presented.fingerprint, type: presented.type },
    };
  }
  return {
    status: 'fail',
    detail: opts.revealPresented
      ? `The host presents ${key}, but ${opts.pinned} is pinned. Connections are refused until the change is reviewed.`
      : 'The host presents a different key than the one pinned. Connections are refused until an admin reviews the change.',
    remediation:
      'If the server was rebuilt or its keys regenerated, an admin can accept the new key from the host key panel. Otherwise treat it as a possible man-in-the-middle and investigate first.',
    ...(opts.revealPresented && { data: { presented: presented.fingerprint, type: presented.type, pinned: opts.pinned } }),
  };
}
