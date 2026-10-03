import { X509Certificate, createPrivateKey } from 'node:crypto';
import { isIP } from 'node:net';
import { parse as parseYaml } from 'yaml';
import type { KubeAuthType, KubeconfigContext, KubeconfigSummary } from '@smt/shared';
import { KubeError } from './errors.js';

/**
 * Uploaded kubeconfig files (spec §2.6). What we take from a context: the API
 * server URL, its CA, and a bearer token or a client certificate and key —
 * all embedded in the file. What we refuse, with a message saying why and
 * what to do instead:
 *
 * - `exec` and `auth-provider` users: they run a program on the app host to
 *   get a token (aws, gcloud, kubelogin…). Create a service account token;
 *   the docs show how for EKS/GKE/AKS/k3s/kind.
 * - `insecure-skip-tls-verify`: TLS is always verified against the CA.
 * - Paths to files (`certificate-authority`, `client-key`, `token-file`):
 *   they name files on another machine — embed them (`kubectl config view
 *   --minify --flatten`).
 * - Basic auth, proxies and `tls-server-name`: not supported.
 *
 * Parsing never connects anywhere and nothing is stored here.
 */

/** Largest kubeconfig accepted. */
export const MAX_KUBECONFIG_BYTES = 512 * 1024;

const FLATTEN_HINT = 'Embed it with `kubectl config view --minify --flatten --context <name>` and upload that.';
const SERVICE_ACCOUNT_HINT =
  'Create a service account token for BastionSSH instead — see "Kubernetes" in the README for EKS, GKE, AKS, k3s and kind.';

export type KubeCredential = { type: 'token'; token: string } | { type: 'cert'; cert: string; key: string };

/** A context resolved to everything needed to connect. */
export interface KubeConnection {
  apiUrl: string;
  /** PEM, or null for the system trust store. */
  caData: string | null;
  credential: KubeCredential;
  namespace: string | null;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function named(list: unknown, what: string): Map<string, Json> {
  const out = new Map<string, Json>();
  if (list === undefined || list === null) return out;
  if (!Array.isArray(list)) throw new KubeError(`The kubeconfig's ${what} is not a list`, 400);
  for (const entry of list) {
    if (!isObject(entry) || typeof entry.name !== 'string') continue;
    const body = entry[what === 'clusters' ? 'cluster' : what === 'users' ? 'user' : 'context'];
    out.set(entry.name, isObject(body) ? body : {});
  }
  return out;
}

function decodeBase64Pem(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new KubeError(`${what} is empty`, 400);
  const text = Buffer.from(value.trim(), 'base64').toString('utf8');
  if (!text.includes('-----BEGIN')) throw new KubeError(`${what} is not base64-encoded PEM`, 400);
  return text;
}

/** A PEM bundle of one or more certificates, checked by parsing each. */
export function checkCertificates(pem: string, what: string): string {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks?.length) throw new KubeError(`${what} has no PEM certificate in it`, 400);
  for (const block of blocks) {
    try {
      new X509Certificate(block);
    } catch {
      throw new KubeError(`${what} is not a valid certificate`, 400);
    }
  }
  return blocks.join('\n') + '\n';
}

export function checkPrivateKey(pem: string): string {
  try {
    createPrivateKey(pem);
  } catch {
    throw new KubeError('The client key is not a valid PEM private key', 400);
  }
  return pem.trim() + '\n';
}

/**
 * An API server URL: https only (the credential is sent over it), a host,
 * an optional port and path prefix (Rancher and other proxies), nothing else.
 * Returned normalized, without a trailing slash.
 */
export function checkApiUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new KubeError('The API server URL is required', 400);
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new KubeError('The API server URL is not a valid URL', 400);
  }
  if (url.protocol !== 'https:') {
    throw new KubeError('The API server URL must use https:// — the credential is sent over it', 400);
  }
  if (url.username || url.password) throw new KubeError('The API server URL must not carry a username or password', 400);
  if (url.search || url.hash) throw new KubeError('The API server URL must not have a query or fragment', 400);
  const path = url.pathname.replace(/\/+$/, '');
  return `https://${url.host}${path}`;
}

/** Host and port of an API URL, and its path prefix ('' for none). */
export function apiEndpoint(apiUrl: string): { host: string; port: number; basePath: string } {
  const url = new URL(apiUrl);
  // URL keeps IPv6 hosts in brackets
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return { host, port: url.port ? Number(url.port) : 443, basePath: url.pathname.replace(/\/+$/, '') };
}

/** SNI for a host: the name itself, or none for an IP address (TLS does not allow one). */
export function serverNameFor(host: string): string | undefined {
  return isIP(host) === 0 ? host : undefined;
}

/** Why a cluster entry cannot be used, or null. */
function clusterProblem(cluster: Json): string | null {
  if (cluster['insecure-skip-tls-verify'] === true) {
    return 'It sets insecure-skip-tls-verify. BastionSSH always verifies the API server certificate; give the cluster CA instead.';
  }
  if (typeof cluster['certificate-authority'] === 'string' && !cluster['certificate-authority-data']) {
    return `Its CA is a file path (certificate-authority). ${FLATTEN_HINT}`;
  }
  if (cluster['proxy-url']) return 'It uses proxy-url, which is not supported. Connect through a managed server instead.';
  if (cluster['tls-server-name']) return 'It sets tls-server-name, which is not supported. Use a server URL with that name.';
  if (typeof cluster.server !== 'string' || !cluster.server) return 'It has no server URL.';
  return null;
}

/** Why a user entry cannot be used, or null; and its auth type when it can. */
function userProblem(user: Json): { problem: string | null; authType: KubeAuthType | null } {
  if (user.exec) {
    return {
      problem: `It gets its credentials by running a program (exec), which BastionSSH never does on its host. ${SERVICE_ACCOUNT_HINT}`,
      authType: null,
    };
  }
  if (user['auth-provider']) {
    return { problem: `It uses an auth-provider plugin, which is not supported. ${SERVICE_ACCOUNT_HINT}`, authType: null };
  }
  if (typeof user['token-file'] === 'string' && !user.token) {
    return { problem: `Its token is a file path (token-file). Paste the token itself, or ${FLATTEN_HINT.toLowerCase()}`, authType: null };
  }
  if (typeof user.token === 'string' && user.token) return { problem: null, authType: 'token' };
  const certData = user['client-certificate-data'];
  const keyData = user['client-key-data'];
  if (certData || keyData) {
    if (!certData || !keyData) return { problem: 'It has a client certificate or key, but not both.', authType: null };
    return { problem: null, authType: 'cert' };
  }
  if (user['client-certificate'] || user['client-key']) {
    return { problem: `Its client certificate is a file path. ${FLATTEN_HINT}`, authType: null };
  }
  if (user.username || user.password) {
    return { problem: `It uses a username and password, which Kubernetes no longer supports. ${SERVICE_ACCOUNT_HINT}`, authType: null };
  }
  return { problem: `It has no credentials. ${SERVICE_ACCOUNT_HINT}`, authType: null };
}

interface ParsedKubeconfig {
  currentContext: string | null;
  clusters: Map<string, Json>;
  users: Map<string, Json>;
  contexts: Map<string, Json>;
}

function load(text: string): ParsedKubeconfig {
  if (typeof text !== 'string' || !text.trim()) throw new KubeError('The kubeconfig is empty', 400);
  if (Buffer.byteLength(text) > MAX_KUBECONFIG_BYTES) throw new KubeError('The kubeconfig is too large', 400);
  let doc: unknown;
  try {
    // Plain YAML only: no custom tags, aliases capped (a "billion laughs" file is refused)
    doc = parseYaml(text, { maxAliasCount: 50, prettyErrors: false });
  } catch (err) {
    throw new KubeError(`The kubeconfig is not valid YAML: ${(err as Error).message.split('\n')[0]}`, 400);
  }
  if (!isObject(doc)) throw new KubeError('The kubeconfig is not a kubeconfig file', 400);
  if (doc.kind !== undefined && doc.kind !== 'Config') throw new KubeError('The file is not a kubeconfig (kind: Config)', 400);
  return {
    currentContext: typeof doc['current-context'] === 'string' && doc['current-context'] ? doc['current-context'] : null,
    clusters: named(doc.clusters, 'clusters'),
    users: named(doc.users, 'users'),
    contexts: named(doc.contexts, 'contexts'),
  };
}

/** The contexts of a kubeconfig, each with what is wrong with it, for the picker. Nothing is kept. */
export function summarizeKubeconfig(text: string): KubeconfigSummary {
  const parsed = load(text);
  if (parsed.contexts.size === 0) throw new KubeError('The kubeconfig has no contexts', 400);
  const contexts: KubeconfigContext[] = [];
  for (const [name, ctx] of parsed.contexts) {
    const clusterName = typeof ctx.cluster === 'string' ? ctx.cluster : '';
    const userName = typeof ctx.user === 'string' ? ctx.user : '';
    const cluster = parsed.clusters.get(clusterName);
    const user = parsed.users.get(userName);
    let problem: string | null = null;
    let authType: KubeAuthType | null = null;
    if (!cluster) problem = `Its cluster "${clusterName}" is not in the file.`;
    else if (!user) problem = `Its user "${userName}" is not in the file.`;
    else {
      problem = clusterProblem(cluster);
      const u = userProblem(user);
      authType = u.authType;
      problem ??= u.problem;
    }
    if (!problem && cluster) {
      try {
        checkApiUrl(cluster.server);
      } catch (err) {
        problem = (err as Error).message;
      }
    }
    contexts.push({
      name,
      cluster: clusterName,
      user: userName,
      namespace: typeof ctx.namespace === 'string' && ctx.namespace ? ctx.namespace : null,
      server: cluster && typeof cluster.server === 'string' ? cluster.server : null,
      authType,
      hasCa: !!cluster?.['certificate-authority-data'],
      problem,
    });
  }
  return { currentContext: parsed.currentContext, contexts };
}

/**
 * Everything needed to connect, from one context (default: the file's
 * current-context, or its only one). Throws 400 with the reason when the
 * context cannot be used.
 */
export function connectionFromKubeconfig(text: string, contextName?: string): KubeConnection {
  const parsed = load(text);
  const name = contextName || parsed.currentContext || (parsed.contexts.size === 1 ? [...parsed.contexts.keys()][0] : null);
  if (!name) throw new KubeError('The kubeconfig has several contexts and no current-context; pick one', 400);
  const ctx = parsed.contexts.get(name);
  if (!ctx) throw new KubeError(`The kubeconfig has no context "${name}"`, 400);
  const cluster = parsed.clusters.get(typeof ctx.cluster === 'string' ? ctx.cluster : '');
  const user = parsed.users.get(typeof ctx.user === 'string' ? ctx.user : '');
  if (!cluster) throw new KubeError(`Context "${name}": its cluster is not in the file`, 400);
  if (!user) throw new KubeError(`Context "${name}": its user is not in the file`, 400);
  const problem = clusterProblem(cluster) ?? userProblem(user).problem;
  if (problem) throw new KubeError(`Context "${name}" cannot be used. ${problem}`, 400);

  const apiUrl = checkApiUrl(cluster.server);
  const caData = cluster['certificate-authority-data']
    ? checkCertificates(decodeBase64Pem(cluster['certificate-authority-data'], 'The cluster CA'), 'The cluster CA')
    : null;
  const credential: KubeCredential =
    typeof user.token === 'string' && user.token
      ? { type: 'token', token: checkToken(user.token) }
      : {
          type: 'cert',
          cert: checkCertificates(decodeBase64Pem(user['client-certificate-data'], 'The client certificate'), 'The client certificate'),
          key: checkPrivateKey(decodeBase64Pem(user['client-key-data'], 'The client key')),
        };
  return {
    apiUrl,
    caData,
    credential,
    namespace: typeof ctx.namespace === 'string' && ctx.namespace ? ctx.namespace : null,
  };
}

/** A bearer token: one line of visible characters. */
export function checkToken(raw: unknown): string {
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) throw new KubeError('The token is empty', 400);
  if (token.length > 16 * 1024 || !/^[\x21-\x7e]+$/.test(token)) throw new KubeError('The token is not a valid bearer token', 400);
  return token;
}

/** What the UI shows instead of a credential: `token ending …abcd`, `client certificate CN=admin`. */
export function credentialHint(credential: KubeCredential): string {
  if (credential.type === 'token') return `token ending …${credential.token.slice(-4)}`;
  try {
    const subject = new X509Certificate(credential.cert).subject;
    const cn = /(?:^|\n)CN=([^\n]+)/.exec(subject)?.[1];
    return cn ? `client certificate CN=${cn}` : 'client certificate';
  } catch {
    return 'client certificate';
  }
}
