import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { DiagnosticsDeps } from './steps.js';

/**
 * Stand-ins for dns/net/tls so every diagnostic outcome can be produced on
 * demand. Test-only.
 */

export const FINGERPRINT = 'SHA256:7RzRboFL75PCBozdMj7VbF+Y5sel8sTZxSqUkmATKNk';
export const OTHER_FINGERPRINT = 'SHA256:S7Axguai+B29/IGiF9tcSRxdklcSxD2vNoSLuUdBD8U';

export function codedError(code: string, message = `${code} (fake)`): Error {
  return Object.assign(new Error(message), { code });
}

/** A socket that records writes and answers them through `respond`. */
export class FakeSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;

  constructor(private readonly respond?: (chunk: string, socket: FakeSocket) => void) {
    super();
  }

  write(chunk: string): boolean {
    this.written.push(chunk);
    this.respond?.(chunk, this);
    return true;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  /** Deliver bytes from the "server" on the next tick. */
  send(text: string): void {
    setImmediate(() => this.emit('data', Buffer.from(text, 'latin1')));
  }

  hangUp(): void {
    setImmediate(() => {
      this.emit('end');
      this.emit('close');
    });
  }

  asSocket(): Socket {
    return this as unknown as Socket;
  }
}

export type ConnectBehaviour =
  | { kind: 'connect'; greeting?: string; respond?: (chunk: string, socket: FakeSocket) => void; hangUp?: boolean }
  | { kind: 'error'; code: string }
  | { kind: 'hang' };

/** A `connect` that behaves as told, remembering every socket it handed out. */
export function fakeConnect(behaviour: ConnectBehaviour) {
  const sockets: FakeSocket[] = [];
  const connect = (_address: string, _port: number): Socket => {
    const socket = new FakeSocket(behaviour.kind === 'connect' ? behaviour.respond : undefined);
    sockets.push(socket);
    setImmediate(() => {
      if (behaviour.kind === 'error') socket.emit('error', codedError(behaviour.code));
      if (behaviour.kind === 'connect') {
        socket.emit('connect');
        if (behaviour.greeting) socket.send(behaviour.greeting);
        if (behaviour.hangUp) setImmediate(() => socket.hangUp());
      }
    });
    return socket.asSocket();
  };
  return { connect, sockets };
}

export interface FakeCert {
  authorized: boolean;
  authorizationError?: string;
  subject?: string;
  issuer?: string;
  validTo?: string;
  protocol?: string;
}

/** A TLS "handshake" that succeeds with the given certificate, or fails with `error`. */
export function fakeTls(opts: { cert?: FakeCert; error?: string; afterHandshake?: string }) {
  const calls: Array<Record<string, unknown>> = [];
  const tlsConnect = (options: Record<string, unknown>): TLSSocket => {
    calls.push(options);
    const socket = new FakeSocket() as FakeSocket & Record<string, unknown>;
    const cert = opts.cert;
    socket.authorized = cert?.authorized ?? false;
    socket.authorizationError = cert?.authorizationError;
    socket.getProtocol = () => cert?.protocol ?? 'TLSv1.3';
    socket.getPeerCertificate = () => ({
      subject: { CN: cert?.subject ?? 'files.example.com' },
      issuer: { O: cert?.issuer ?? 'Let’s Encrypt' },
      valid_to: cert?.validTo ?? new Date(Date.now() + 90 * 86_400_000).toUTCString(),
    });
    setImmediate(() => {
      if (opts.error) socket.emit('error', codedError('ERR_SSL_WRONG_VERSION_NUMBER', opts.error));
      else {
        socket.emit('secureConnect');
        if (opts.afterHandshake) socket.send(opts.afterHandshake);
      }
    });
    return socket as unknown as TLSSocket;
  };
  return { tlsConnect: tlsConnect as unknown as DiagnosticsDeps['tlsConnect'], calls };
}

/** Deps that resolve to one public IPv4 address and connect to an OpenSSH banner. */
export function fakeDeps(overrides: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  return {
    lookup: async () => [{ address: '203.0.113.10', family: 4 }],
    resolve4: async () => ['203.0.113.10'],
    connect: fakeConnect({ kind: 'connect', greeting: 'SSH-2.0-OpenSSH_9.6\r\n' }).connect,
    tlsConnect: () => {
      throw new Error('TLS not expected in this test');
    },
    scanHostKey: async () => ({ fingerprint: FINGERPRINT, type: 'ssh-ed25519' }),
    ...overrides,
  };
}
