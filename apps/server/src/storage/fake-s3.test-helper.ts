import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny S3 for route tests: path-style ListObjectsV2 (prefix, delimiter,
 * max-keys, continuation tokens) and GetObject over real HTTP, so the SDK,
 * its signing, streaming and abort handling all run for real. Signatures are
 * not checked. Objects are held in memory, or generated (`size` + a byte
 * pattern) when a test needs a large one.
 */

export interface FakeObject {
  data?: Buffer;
  /** A generated body of this many bytes when `data` is absent. */
  size?: number;
  mtime?: Date;
  /** Answer GetObject this many ms late (headers included). */
  delayMs?: number;
  /** Send the headers and this many bytes, then stall until the client goes away. */
  stallAfter?: number;
  /** Listed, but deleted before anyone fetches it: GetObject answers NoSuchKey. */
  gone?: boolean;
}

export interface FakeS3 {
  endpoint: string;
  buckets: Map<string, Map<string, FakeObject>>;
  /** Most keys any ListObjectsV2 page holds, whatever max-keys asks for (forces pagination). */
  pageSize: number;
  stats: {
    lists: number;
    gets: string[];
    /** GetObject requests the client gave up on before the body was complete. */
    abortedGets: string[];
    /** GetObject bodies sent in full. */
    completedGets: string[];
  };
  put(bucket: string, key: string, obj: FakeObject | string | Buffer): void;
  close(): Promise<void>;
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function errorXml(res: http.ServerResponse, status: number, code: string, message: string) {
  res.writeHead(status, { 'Content-Type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`);
}

function sizeOf(o: FakeObject): number {
  return o.data ? o.data.length : (o.size ?? 0);
}

/** S3 orders keys by their UTF-8 bytes. */
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export async function startFakeS3(): Promise<FakeS3> {
  const sockets = new Set<import('node:net').Socket>();
  const fake: FakeS3 = {
    endpoint: '',
    buckets: new Map(),
    pageSize: 1000,
    stats: { lists: 0, gets: [], abortedGets: [], completedGets: [] },
    put(bucket, key, obj) {
      let b = fake.buckets.get(bucket);
      if (!b) fake.buckets.set(bucket, (b = new Map()));
      b.set(key, typeof obj === 'string' || Buffer.isBuffer(obj) ? { data: Buffer.from(obj) } : obj);
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };

  const list = (res: http.ServerResponse, bucketName: string, objects: Map<string, FakeObject>, q: URLSearchParams) => {
    fake.stats.lists++;
    const prefix = q.get('prefix') ?? '';
    const delimiter = q.get('delimiter') ?? '';
    const maxKeys = Math.min(Number(q.get('max-keys') ?? 1000), fake.pageSize);
    const urlEncoded = q.get('encoding-type') === 'url';
    const enc = (s: string) => xml(urlEncoded ? encodeURIComponent(s).replace(/%2F/g, '/') : s);
    // Every result in order — keys and rolled-up common prefixes — then one page of them
    const results: Array<{ key: string } | { prefix: string }> = [];
    const seen = new Set<string>();
    for (const key of [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(byteOrder)) {
      const cut = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
      if (cut === -1) results.push({ key });
      else {
        const p = key.slice(0, cut + delimiter.length);
        if (!seen.has(p)) {
          seen.add(p);
          results.push({ prefix: p });
        }
      }
    }
    const start = q.get('continuation-token') ? Number(Buffer.from(q.get('continuation-token')!, 'base64').toString()) : 0;
    const page = results.slice(start, start + maxKeys);
    const truncated = start + maxKeys < results.length;
    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
      `<Name>${xml(bucketName)}</Name><Prefix>${enc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>`,
      `<MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>`,
      urlEncoded ? '<EncodingType>url</EncodingType>' : '',
      delimiter ? `<Delimiter>${enc(delimiter)}</Delimiter>` : '',
      truncated ? `<NextContinuationToken>${Buffer.from(String(start + maxKeys)).toString('base64')}</NextContinuationToken>` : '',
      ...page.map((r) => {
        if ('prefix' in r) return `<CommonPrefixes><Prefix>${enc(r.prefix)}</Prefix></CommonPrefixes>`;
        const o = objects.get(r.key)!;
        return (
          `<Contents><Key>${enc(r.key)}</Key><LastModified>${(o.mtime ?? new Date('2026-01-02T03:04:05Z')).toISOString()}</LastModified>` +
          `<ETag>"etag"</ETag><Size>${sizeOf(o)}</Size><StorageClass>STANDARD</StorageClass></Contents>`
        );
      }),
      '</ListBucketResult>',
    ].join('');
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(body);
  };

  const get = (req: http.IncomingMessage, res: http.ServerResponse, key: string, o: FakeObject) => {
    fake.stats.gets.push(key);
    const size = sizeOf(o);
    let done = false;
    res.on('close', () => {
      if (!done) fake.stats.abortedGets.push(key);
    });
    const send = async () => {
      if (res.destroyed) return;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
        'Last-Modified': (o.mtime ?? new Date('2026-01-02T03:04:05Z')).toUTCString(),
        ETag: '"etag"',
      });
      const chunk = 64 * 1024;
      for (let sent = 0; sent < size; ) {
        if (res.destroyed) return;
        if (o.stallAfter !== undefined && sent >= o.stallAfter) return; // until the client hangs up
        const n = Math.min(chunk, size - sent, o.stallAfter !== undefined ? o.stallAfter - sent : Infinity);
        const piece = o.data ? o.data.subarray(sent, sent + n) : Buffer.alloc(n, sent % 251);
        sent += n;
        if (!res.write(piece)) {
          await new Promise<void>((resolve) => {
            const done = () => {
              res.off('drain', done).off('close', done);
              resolve();
            };
            res.on('drain', done).on('close', done);
          });
        }
      }
      done = true;
      fake.stats.completedGets.push(key);
      res.end();
    };
    if (o.delayMs) setTimeout(() => void send(), o.delayMs);
    else void send();
    void req;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const [, bucketName = '', ...rest] = url.pathname.split('/');
    const bucket = fake.buckets.get(decodeURIComponent(bucketName));
    if (!bucket) return errorXml(res, 404, 'NoSuchBucket', 'The specified bucket does not exist');
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') return list(res, decodeURIComponent(bucketName), bucket, url.searchParams);
    const key = rest.map(decodeURIComponent).join('/');
    const o = bucket.get(key);
    if (req.method === 'GET' && o && !o.gone) return get(req, res, key, o);
    return errorXml(res, 404, 'NoSuchKey', 'The specified key does not exist.');
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

/** The generated body `startFakeS3` serves for an object given only a size. */
export function generatedBody(size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let sent = 0; sent < size; sent += 64 * 1024) out.fill(sent % 251, sent, Math.min(size, sent + 64 * 1024));
  return out;
}
