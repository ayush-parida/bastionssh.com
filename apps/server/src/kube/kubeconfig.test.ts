import { describe, it, expect } from 'vitest';
import { stringify } from 'yaml';
import {
  apiEndpoint,
  checkApiUrl,
  checkToken,
  connectionFromKubeconfig,
  credentialHint,
  serverNameFor,
  summarizeKubeconfig,
} from './kubeconfig.js';
import { KubeError } from './errors.js';
import { CA_CERT, CLIENT_CERT, CLIENT_KEY } from './test-certs.test-helper.js';

const b64 = (s: string) => Buffer.from(s).toString('base64');

function kubeconfig(user: Record<string, unknown>, cluster: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return stringify({
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': 'prod',
    clusters: [{ name: 'prod-cluster', cluster: { server: 'https://k8s.example.com:6443', 'certificate-authority-data': b64(CA_CERT), ...cluster } }],
    users: [{ name: 'prod-user', user }],
    contexts: [{ name: 'prod', context: { cluster: 'prod-cluster', user: 'prod-user', namespace: 'shop' } }],
    ...extra,
  });
}

function refusal(text: string, context?: string): string {
  try {
    connectionFromKubeconfig(text, context);
  } catch (err) {
    expect(err).toBeInstanceOf(KubeError);
    expect((err as KubeError).statusCode).toBe(400);
    return (err as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('kubeconfig', () => {
  it('takes the server, CA, token and namespace from the current context', () => {
    const conn = connectionFromKubeconfig(kubeconfig({ token: 'abc.def-123' }));
    expect(conn).toMatchObject({
      apiUrl: 'https://k8s.example.com:6443',
      credential: { type: 'token', token: 'abc.def-123' },
      namespace: 'shop',
    });
    expect(conn.caData).toContain('-----BEGIN CERTIFICATE-----');
  });

  it('takes an embedded client certificate and key', () => {
    const conn = connectionFromKubeconfig(
      kubeconfig({ 'client-certificate-data': b64(CLIENT_CERT), 'client-key-data': b64(CLIENT_KEY) }),
    );
    expect(conn.credential.type).toBe('cert');
    expect(credentialHint(conn.credential)).toBe('client certificate CN=bastion-admin');
  });

  it('refuses exec and auth-provider users, explaining what to do instead', () => {
    expect(refusal(kubeconfig({ exec: { command: 'aws', args: ['eks', 'get-token'] } }))).toMatch(/running a program \(exec\).*service account/s);
    expect(refusal(kubeconfig({ 'auth-provider': { name: 'gcp' } }))).toMatch(/auth-provider/);
  });

  it('refuses insecure-skip-tls-verify, file paths, proxies and basic auth', () => {
    expect(refusal(kubeconfig({ token: 't' }, { 'insecure-skip-tls-verify': true }))).toMatch(/insecure-skip-tls-verify/);
    expect(refusal(kubeconfig({ token: 't' }, { 'certificate-authority-data': undefined, 'certificate-authority': '/etc/ca.crt' }))).toMatch(
      /file path.*--flatten/s,
    );
    expect(refusal(kubeconfig({ 'client-certificate': '/a.crt', 'client-key': '/a.key' }))).toMatch(/file path/);
    expect(refusal(kubeconfig({ 'token-file': '/var/run/token' }))).toMatch(/token-file/);
    expect(refusal(kubeconfig({ token: 't' }, { 'proxy-url': 'http://proxy:3128' }))).toMatch(/proxy-url/);
    expect(refusal(kubeconfig({ username: 'admin', password: 'x' }))).toMatch(/username and password/);
    expect(refusal(kubeconfig({}))).toMatch(/no credentials/);
  });

  it('refuses plain-http servers and a certificate without its key', () => {
    expect(refusal(kubeconfig({ token: 't' }, { server: 'http://k8s.example.com:8080' }))).toMatch(/https/);
    expect(refusal(kubeconfig({ 'client-certificate-data': b64(CLIENT_CERT) }))).toMatch(/not both/);
  });

  it('refuses YAML that is not a kubeconfig, too large, or an alias bomb', () => {
    expect(refusal('just: [unclosed')).toMatch(/not valid YAML/);
    expect(refusal('kind: Pod\napiVersion: v1\n')).toMatch(/kind: Config/);
    expect(refusal('a'.repeat(600 * 1024))).toMatch(/too large/);
    const bomb = ['a: &a [x,x,x,x,x,x,x,x,x]', ...Array.from({ length: 60 }, (_, i) => `b${i}: &b${i} [*${i ? `b${i - 1}` : 'a'},*${i ? `b${i - 1}` : 'a'}]`), 'kind: Config'].join('\n');
    expect(() => connectionFromKubeconfig(bomb)).toThrow(KubeError);
  });

  it('lists every context with what is wrong with it, and picks one by name', () => {
    const text = stringify({
      kind: 'Config',
      clusters: [
        { name: 'a', cluster: { server: 'https://a.example.com', 'certificate-authority-data': b64(CA_CERT) } },
        { name: 'b', cluster: { server: 'https://b.example.com', 'insecure-skip-tls-verify': true } },
      ],
      users: [
        { name: 'sa', user: { token: 'tok' } },
        { name: 'eks', user: { exec: { command: 'aws' } } },
      ],
      contexts: [
        { name: 'good', context: { cluster: 'a', user: 'sa' } },
        { name: 'insecure', context: { cluster: 'b', user: 'sa' } },
        { name: 'eks', context: { cluster: 'a', user: 'eks' } },
        { name: 'dangling', context: { cluster: 'missing', user: 'sa' } },
      ],
    });
    const summary = summarizeKubeconfig(text);
    expect(summary.currentContext).toBeNull();
    expect(summary.contexts.map((c) => [c.name, c.problem === null, c.authType])).toEqual([
      ['good', true, 'token'],
      ['insecure', false, 'token'],
      ['eks', false, null],
      ['dangling', false, null],
    ]);
    // Several contexts and no current one: the caller must pick
    expect(refusal(text)).toMatch(/pick one/);
    expect(connectionFromKubeconfig(text, 'good').apiUrl).toBe('https://a.example.com');
    expect(refusal(text, 'eks')).toMatch(/exec/);
    expect(refusal(text, 'nope')).toMatch(/no context "nope"/);
  });

  it('normalizes API URLs and knows where to connect', () => {
    expect(checkApiUrl(' https://k8s.example.com:6443/ ')).toBe('https://k8s.example.com:6443');
    expect(checkApiUrl('https://rancher.example.com/k8s/clusters/c-123')).toBe('https://rancher.example.com/k8s/clusters/c-123');
    expect(() => checkApiUrl('https://user:pw@k8s.example.com')).toThrow(/username/);
    expect(() => checkApiUrl('https://k8s.example.com/?x=1')).toThrow(/query/);
    expect(apiEndpoint('https://[::1]:6443/base')).toEqual({ host: '::1', port: 6443, basePath: '/base' });
    expect(apiEndpoint('https://k8s.example.com')).toEqual({ host: 'k8s.example.com', port: 443, basePath: '' });
    expect(serverNameFor('k8s.example.com')).toBe('k8s.example.com');
    expect(serverNameFor('10.0.0.5')).toBeUndefined();
  });

  it('checks tokens and hints at them without revealing them', () => {
    expect(() => checkToken('has space')).toThrow(KubeError);
    expect(() => checkToken('')).toThrow(/empty/);
    expect(credentialHint({ type: 'token', token: 'secret-token-wxyz' })).toBe('token ending …wxyz');
  });
});
