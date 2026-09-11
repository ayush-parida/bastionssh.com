import { describe, it, expect } from 'vitest';
import { buildClientConfig, type StorageTarget } from './client.js';

const minio: StorageTarget = {
  provider: 'minio',
  endpoint: 'http://minio.local:9000',
  region: 'us-east-1',
  accessKeyId: 'AKIA',
  forcePathStyle: true,
};

describe('buildClientConfig', () => {
  it('points at a custom endpoint with path-style addressing', () => {
    const cfg = buildClientConfig(minio, 'secret');
    expect(cfg.endpoint).toBe('http://minio.local:9000');
    expect(cfg.forcePathStyle).toBe(true);
    expect(cfg.credentials).toEqual({ accessKeyId: 'AKIA', secretAccessKey: 'secret' });
  });

  it('omits the endpoint for AWS so the SDK derives it from the region', () => {
    const cfg = buildClientConfig(
      { ...minio, provider: 's3', endpoint: null, region: 'eu-west-1', forcePathStyle: false },
      's',
    );
    expect(cfg).not.toHaveProperty('endpoint');
    expect(cfg.region).toBe('eu-west-1');
    expect(cfg.forcePathStyle).toBe(false);
  });

  it('falls back to us-east-1 when the region is blank', () => {
    expect(buildClientConfig({ ...minio, region: '  ' }, 's').region).toBe('us-east-1');
  });

  it('only checksums when the operation demands it, and follows region redirects', () => {
    const cfg = buildClientConfig(minio, 's');
    expect(cfg.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    expect(cfg.responseChecksumValidation).toBe('WHEN_REQUIRED');
    expect(cfg.followRegionRedirects).toBe(true);
  });
});
