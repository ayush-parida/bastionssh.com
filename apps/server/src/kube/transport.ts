import { lookup } from 'node:dns/promises';
import net, { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import tls, { type TLSSocket } from 'node:tls';
import type { ClientChannel } from 'ssh2';
import type { KubeConnectVia } from '@smt/shared';
import { openAgentTunnel } from '../agents/hub.js';
import { blockedReason, type AllowNets } from '../net/ssrf.js';
import { asSocket } from '../docker/transport.js';
import { apiEndpoint, serverNameFor, type KubeCredential } from './kubeconfig.js';
import { KubeError, fromTransportError } from './errors.js';
import { acquireServerSsh } from './ssh-pool.js';

/**
 * Sockets to a cluster's API server (spec §2.4–2.5). The byte stream comes
 * from one of three routes:
 *
 * - `direct`: TCP from this host. The name is resolved here and every
 *   address it resolves to is checked like a server's host — private
 *   networks are fine, metadata services and link-local are not — and the
 *   connection goes to the checked address, so a DNS answer cannot change
 *   in between.
 * - `server`: a `forwardOut` channel on a pooled SSH connection to a managed
 *   server (kube/ssh-pool.ts: `sshConnectConfig` + `connectSsh`); the server
 *   resolves and dials the API host.
 * - `agent`: the connectivity agent's tunnel to a port on its own loopback
 *   (the agent must run on a control-plane node and allow the port).
 *
 * TLS then always runs end to end from here: verified against the cluster CA
 * (or the system store when none was given), with SNI and the certificate
 * name check against the API URL's host — the same through every route. A
 * client certificate, when that is the credential, is presented here too.
 */

export const CONNECT_TIMEOUT_MS = 15_000;

/** Everything needed to open a connection to one cluster's API server. */
export interface ApiRoute {
  orgId: string;
  apiUrl: string;
  /** PEM; null trusts the system store. */
  caData: string | null;
  credential: KubeCredential;
  connectVia: KubeConnectVia;
  viaServerId: string | null;
  viaAgentId: string | null;
  /** A jump hop on a fresh SSH connection is audited under them. */
  actorUserId?: string;
}

/** Private ranges are allowed, as for servers; what `blockedReason` always refuses stays refused. */
const ANY_NETWORK: AllowNets = [
  { address: '0.0.0.0', prefix: 0, family: 4 },
  { address: '::', prefix: 0, family: 6 },
];

export interface TransportDeps {
  lookup(host: string): Promise<{ address: string; family: number }[]>;
}

export const defaultTransportDeps: TransportDeps = {
  lookup: (host) => lookup(host, { all: true, verbatim: true }),
};

/** Resolve the API host and return an address that may be connected to. */
export async function safeAddress(host: string, deps: TransportDeps = defaultTransportDeps): Promise<string> {
  let addresses: { address: string; family: number }[];
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
  else {
    try {
      addresses = await deps.lookup(host);
    } catch {
      throw new KubeError(`Could not resolve ${host}`, 502);
    }
  }
  if (!addresses.length) throw new KubeError(`Could not resolve ${host}`, 502);
  for (const a of addresses) {
    const reason = blockedReason(a.address, ANY_NETWORK);
    if (reason) throw new KubeError(`Refusing to connect to ${host}: ${reason}`, 400);
  }
  return addresses[0]!.address;
}

/** Wait for a stream that is still connecting (a TCP socket, an agent tunnel). */
function whenConnected(socket: Duplex & { connecting?: boolean }, what: string): Promise<void> {
  if (!socket.connecting) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new KubeError(`${what} timed out`, 504));
    }, CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function forwardOut(client: import('ssh2').Client, host: string, port: number): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(new KubeError('Opening the tunnel to the API server timed out', 504));
    }, CONNECT_TIMEOUT_MS);
    try {
      client.forwardOut('127.0.0.1', 0, host, port, (err, channel) => {
        clearTimeout(timer);
        if (done) return void channel?.destroy();
        done = true;
        if (err) {
          return reject(
            new KubeError(
              `The server could not open a connection to ${host}:${port} (${err.message}) — check that it can reach the API server and allows TCP forwarding`,
              502,
            ),
          );
        }
        resolve(channel);
      });
    } catch (err) {
      clearTimeout(timer);
      done = true;
      reject(err);
    }
  });
}

/** The raw byte stream to the API server, by route; `release` returns what it borrowed. */
export async function openRaw(route: ApiRoute, deps: TransportDeps = defaultTransportDeps): Promise<{ stream: Duplex; release: () => void }> {
  const { host, port } = apiEndpoint(route.apiUrl);
  switch (route.connectVia) {
    case 'direct': {
      const address = await safeAddress(host, deps);
      const socket = net.connect({ host: address, port });
      await whenConnected(socket, `Connecting to ${host}:${port}`);
      return { stream: socket, release: () => {} };
    }
    case 'server': {
      if (!route.viaServerId) {
        throw new KubeError('This cluster is reached through a server that no longer exists; pick another route', 400);
      }
      const lease = await acquireServerSsh(route.orgId, route.viaServerId, route.actorUserId);
      try {
        const channel = await forwardOut(lease.client, host, port);
        return { stream: channel, release: lease.release };
      } catch (err) {
        lease.release();
        throw err;
      }
    }
    case 'agent': {
      if (!route.viaAgentId) {
        throw new KubeError('This cluster is reached through an agent that no longer exists; pick another route', 400);
      }
      const socket = openAgentTunnel({ orgId: route.orgId, agentId: route.viaAgentId }, port);
      await whenConnected(socket as unknown as Duplex & { connecting: boolean }, 'Opening the agent tunnel');
      return { stream: socket, release: () => {} };
    }
    default:
      throw new KubeError('Unknown connection route', 400);
  }
}

/**
 * Run TLS over a raw stream from {@link openRaw}: verified against the CA,
 * with SNI and the name check against the API URL's host. The raw stream is
 * destroyed and released with the TLS socket (or when the handshake fails).
 */
export function startTls(route: ApiRoute, raw: { stream: Duplex; release: () => void }): Promise<TLSSocket> {
  const { host } = apiEndpoint(route.apiUrl);
  const cert = route.credential.type === 'cert' ? route.credential : null;
  return new Promise<TLSSocket>((resolve, reject) => {
    let settled = false;
    const secure = tls.connect({
      socket: asSocket(raw.stream),
      // Identity is checked against the URL's host whatever the route
      host,
      servername: serverNameFor(host),
      ...(route.caData && { ca: route.caData }),
      ...(cert && { cert: cert.cert, key: cert.key }),
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ALPNProtocols: ['http/1.1'],
    });
    const timer = setTimeout(() => fail(new KubeError('The TLS handshake with the API server timed out', 504)), CONNECT_TIMEOUT_MS);
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      secure.destroy();
      raw.stream.destroy();
      raw.release();
      reject(fromTransportError(err));
    };
    secure.once('secureConnect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      secure.once('close', () => {
        raw.stream.destroy();
        raw.release();
      });
      resolve(secure);
    });
    secure.once('error', fail);
  });
}

/**
 * A verified TLS connection to the API server. Rejected certificates fail
 * with a plain-words KubeError (errors.ts); nothing here ever turns
 * verification off.
 */
export async function openApiSocket(route: ApiRoute, deps: TransportDeps = defaultTransportDeps): Promise<TLSSocket> {
  let raw: { stream: Duplex; release: () => void };
  try {
    raw = await openRaw(route, deps);
  } catch (err) {
    throw fromTransportError(err);
  }
  return startTls(route, raw);
}
