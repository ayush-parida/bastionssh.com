import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { buildClientConfig, createClient, retireClient, type StorageTarget } from './client.js';

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

describe('retireClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('destroys an idle client straight away', () => {
    const client = createClient(minio, 'secret');
    const destroy = vi.spyOn(client, 'destroy');
    retireClient(client);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('waits for a request still in flight before destroying', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let pending: ServerResponse | undefined;
    let arrived!: () => void;
    const requestArrived = new Promise<void>((resolve) => (arrived = resolve));
    const server = createServer((_req, res) => {
      pending = res;
      arrived();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const client = createClient({ ...minio, endpoint: `http://127.0.0.1:${port}` }, 'secret');
      const destroy = vi.spyOn(client, 'destroy');
      const download = client.send(new GetObjectCommand({ Bucket: 'b', Key: 'k' }));
      await requestArrived;

      retireClient(client);
      vi.advanceTimersByTime(60_000);
      expect(destroy).not.toHaveBeenCalled();

      pending!.writeHead(200, { 'content-length': '2' }).end('ok');
      const out = await download;
      expect(await out.Body!.transformToString()).toBe('ok');

      vi.advanceTimersByTime(60_000);
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
