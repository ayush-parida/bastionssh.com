import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { buildJwt, checkTokenUri, gcp, parseServiceAccount, toInstance, zoneToRegion, type GcpInstance } from './gcp.js';

const raw: GcpInstance = {
  id: '5678',
  name: 'api-1',
  status: 'RUNNING',
  machineType: 'https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a/machineTypes/e2-medium',
  networkInterfaces: [{ networkIP: '10.128.0.2', accessConfigs: [{ natIP: '34.1.2.3' }] }],
  labels: { env: 'prod' },
  tags: { items: ['http-server'] },
};

describe('gcp toInstance', () => {
  it('maps an instance', () => {
    expect(toInstance(raw, 'us-central1-a')).toEqual({
      id: '5678',
      name: 'api-1',
      region: 'us-central1',
      state: 'running',
      publicIp: '34.1.2.3',
      privateIp: '10.128.0.2',
      tags: ['env:prod', 'http-server'],
      instanceType: 'e2-medium',
    });
  });

  it('maps TERMINATED → stopped and STAGING → other', () => {
    expect(toInstance({ ...raw, status: 'TERMINATED' }, 'us-central1-a').state).toBe('stopped');
    expect(toInstance({ ...raw, status: 'STAGING' }, 'us-central1-a').state).toBe('other');
  });

  it('has no public ip without an access config', () => {
    expect(toInstance({ ...raw, networkInterfaces: [{ networkIP: '10.0.0.1' }] }, 'z-a').publicIp).toBeNull();
  });

  it('derives the region from the zone', () => {
    expect(zoneToRegion('europe-west1-b')).toBe('europe-west1');
    expect(zoneToRegion('us-central1')).toBe('us-central1');
  });
});

describe('service account keys', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const keyFile = JSON.stringify({
    type: 'service_account',
    project_id: 'my-proj',
    client_email: 'sync@my-proj.iam.gserviceaccount.com',
    private_key: pem,
    token_uri: 'https://oauth2.googleapis.com/token',
  });

  it('parses the fields we need', () => {
    expect(parseServiceAccount(keyFile)).toMatchObject({
      kind: 'gcp',
      projectId: 'my-proj',
      clientEmail: 'sync@my-proj.iam.gserviceaccount.com',
    });
  });

  it('rejects junk and non-service-account files', () => {
    expect(() => parseServiceAccount('{')).toThrow(/valid JSON/);
    expect(() => parseServiceAccount('{"type":"authorized_user"}')).toThrow(/service account/);
    expect(() => parseServiceAccount('{"type":"service_account","project_id":"p","client_email":"e"}')).toThrow(/missing/);
  });

  it('signs a verifiable RS256 assertion with the right claims', () => {
    const creds = parseServiceAccount(keyFile);
    const jwt = buildJwt(creds, 1_000_000);
    const [header, claims, signature] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: 'sync@my-proj.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/compute.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_000_000,
      exp: 1_003_600,
    });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });
});

describe('token endpoint and cache', () => {
  const pem = (generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  const otherPem = (generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  const file = (over: Record<string, unknown>) =>
    JSON.stringify({
      type: 'service_account',
      project_id: 'p',
      client_email: 'cache@p.iam.gserviceaccount.com',
      private_key: pem,
      ...over,
    });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('only accepts Google https token endpoints', () => {
    expect(checkTokenUri('https://oauth2.googleapis.com/token')).toBe('https://oauth2.googleapis.com/token');
    expect(checkTokenUri('https://accounts.google.com/o/oauth2/token')).toBe('https://accounts.google.com/o/oauth2/token');
    for (const bad of [
      'http://oauth2.googleapis.com/token',
      'https://evil.example.com/token',
      'https://oauth2.googleapis.com.evil.com/token',
      'https://oauth2.googleapis.com:8443/token',
      'http://169.254.169.254/computeMetadata',
      'not a url',
    ]) {
      expect(() => checkTokenUri(bad), bad).toThrow(/token_uri/);
    }
    expect(() => parseServiceAccount(file({ token_uri: 'https://attacker.test/token' }))).toThrow(/token_uri/);
    expect(parseServiceAccount(file({})).tokenUri).toBe('https://oauth2.googleapis.com/token');
  });

  it('mints a new token for a different private key with the same client_email', async () => {
    let mints = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        mints++;
        return new Response(JSON.stringify({ access_token: `tok-${mints}`, expires_in: 1e9 }));
      }
      return new Response(JSON.stringify({ items: {} }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const a = parseServiceAccount(file({}));
    const b = parseServiceAccount(file({ private_key: otherPem }));
    await gcp.listInstances(a, { regions: [], timeoutMs: 1000 });
    await gcp.listInstances(a, { regions: [], timeoutMs: 1000 });
    expect(mints).toBe(1);
    await gcp.listInstances(b, { regions: [], timeoutMs: 1000 });
    expect(mints).toBe(2);
    // Stored credentials with a foreign token_uri are refused before any request
    await expect(
      gcp.listInstances({ ...a, tokenUri: 'https://attacker.test/token' }, { regions: [], timeoutMs: 1000 }),
    ).rejects.toThrow(/token_uri/);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('attacker'))).toBe(false);
  });
});
