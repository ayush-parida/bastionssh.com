import { describe, it, expect } from 'vitest';
import { StorageError } from './errors.js';
import {
  assertBucketParam,
  assertSafeEndpoint,
  baseName,
  normalizeKey,
  normalizePrefix,
  parentPrefix,
  validateBucketName,
} from './keys.js';

describe('normalizeKey', () => {
  it('keeps a plain key', () => {
    expect(normalizeKey('docs/readme.md')).toBe('docs/readme.md');
  });

  it('strips a leading slash and collapses empty or dot segments', () => {
    expect(normalizeKey('/docs//./readme.md')).toBe('docs/readme.md');
  });

  it('rejects traversal, trailing slashes, empty input and null bytes', () => {
    expect(() => normalizeKey('docs/../secret')).toThrow(StorageError);
    expect(() => normalizeKey('docs/')).toThrow(StorageError);
    expect(() => normalizeKey('')).toThrow(StorageError);
    expect(() => normalizeKey('/')).toThrow(StorageError);
    expect(() => normalizeKey('a\0b')).toThrow(StorageError);
  });

  it('reports a 400 for bad input', () => {
    expect.assertions(1);
    try {
      normalizeKey('../x');
    } catch (err) {
      expect((err as StorageError).statusCode).toBe(400);
    }
  });
});

describe('normalizePrefix', () => {
  it('treats empty, undefined and "/" as the bucket root', () => {
    expect(normalizePrefix('')).toBe('');
    expect(normalizePrefix(undefined)).toBe('');
    expect(normalizePrefix('/')).toBe('');
  });

  it('always ends a non-root prefix with a slash', () => {
    expect(normalizePrefix('docs')).toBe('docs/');
    expect(normalizePrefix('docs/')).toBe('docs/');
    expect(normalizePrefix('/docs//2024/')).toBe('docs/2024/');
  });

  it('rejects traversal', () => {
    expect(() => normalizePrefix('docs/../')).toThrow(StorageError);
  });
});

describe('parentPrefix', () => {
  it('returns null at the root', () => {
    expect(parentPrefix('')).toBeNull();
  });

  it('walks up one level, landing on the root as ""', () => {
    expect(parentPrefix('docs/2024/')).toBe('docs/');
    expect(parentPrefix('docs/')).toBe('');
  });
});

describe('baseName', () => {
  it('returns the last segment of a key or prefix', () => {
    expect(baseName('docs/2024/report.pdf')).toBe('report.pdf');
    expect(baseName('docs/2024/')).toBe('2024');
    expect(baseName('report.pdf')).toBe('report.pdf');
    expect(baseName('')).toBe('');
  });
});

describe('validateBucketName', () => {
  it('accepts DNS-compatible names', () => {
    expect(validateBucketName('my-bucket')).toBe('my-bucket');
    expect(validateBucketName('logs.2024')).toBe('logs.2024');
    expect(validateBucketName('abc')).toBe('abc');
  });

  it('rejects names S3 would refuse', () => {
    const bad = [
      'ab',
      'AAA',
      'My-Bucket',
      '-lead',
      'trail-',
      'a..b',
      '192.168.0.1',
      'x'.repeat(64),
      'sp ace',
    ];
    for (const name of bad) {
      expect(() => validateBucketName(name), name).toThrow(StorageError);
    }
  });
});

describe('assertBucketParam', () => {
  it('only rules out what would break a URL or a request', () => {
    expect(assertBucketParam('Legacy_Bucket')).toBe('Legacy_Bucket');
    expect(() => assertBucketParam('')).toThrow(StorageError);
    expect(() => assertBucketParam('a/b')).toThrow(StorageError);
    expect(() => assertBucketParam('a\0b')).toThrow(StorageError);
  });
});

describe('assertSafeEndpoint', () => {
  it('accepts http and https and trims a trailing slash', () => {
    expect(assertSafeEndpoint('http://minio.local:9000/')).toBe('http://minio.local:9000');
    expect(assertSafeEndpoint('https://s3.wasabisys.com')).toBe('https://s3.wasabisys.com');
  });

  it('rejects other schemes, embedded credentials, and metadata addresses', () => {
    expect(() => assertSafeEndpoint('ftp://minio.local')).toThrow(StorageError);
    expect(() => assertSafeEndpoint('not a url')).toThrow(StorageError);
    expect(() => assertSafeEndpoint('http://user:pass@minio.local')).toThrow(StorageError);
    expect(() => assertSafeEndpoint('http://169.254.169.254/latest')).toThrow(StorageError);
    expect(() => assertSafeEndpoint('http://metadata.google.internal')).toThrow(StorageError);
  });
});
