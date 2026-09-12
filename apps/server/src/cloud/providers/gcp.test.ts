import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { buildJwt, parseServiceAccount, toInstance, zoneToRegion, type GcpInstance } from './gcp.js';

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
