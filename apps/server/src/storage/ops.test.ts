import { describe, it, expect } from 'vitest';
import { StorageError } from './errors.js';
import { copySource, isBatchDeleteUnsupported, toListing } from './ops.js';

describe('toListing', () => {
  it('turns common prefixes into folders and contents into objects', () => {
    const listing = toListing('media', 'photos/', {
      CommonPrefixes: [{ Prefix: 'photos/2024/' }, { Prefix: 'photos/raw/' }],
      Contents: [
        { Key: 'photos/', Size: 0 },
        {
          Key: 'photos/cat.jpg',
          Size: 1234,
          LastModified: new Date('2026-01-02T03:04:05Z'),
          ETag: '"abc"',
          StorageClass: 'STANDARD',
        },
      ],
      NextContinuationToken: 'tok',
      IsTruncated: true,
    });

    expect(listing.bucket).toBe('media');
    expect(listing.prefix).toBe('photos/');
    expect(listing.parent).toBe('');
    expect(listing.folders).toEqual([
      { name: '2024', prefix: 'photos/2024/' },
      { name: 'raw', prefix: 'photos/raw/' },
    ]);
    // The folder marker for the prefix itself is not an entry
    expect(listing.objects).toEqual([
      {
        name: 'cat.jpg',
        key: 'photos/cat.jpg',
        size: 1234,
        modifiedAt: '2026-01-02T03:04:05.000Z',
        etag: '"abc"',
        storageClass: 'STANDARD',
      },
    ]);
    expect(listing.nextToken).toBe('tok');
    expect(listing.truncated).toBe(true);
  });

  it('handles an empty root listing', () => {
    const listing = toListing('media', '', {});
    expect(listing).toEqual({
      bucket: 'media',
      prefix: '',
      parent: null,
      folders: [],
      objects: [],
      nextToken: null,
      truncated: false,
    });
  });

  it('fills in defaults for sparse objects', () => {
    const listing = toListing('b', '', { Contents: [{ Key: 'x' }] });
    expect(listing.objects[0]).toEqual({
      name: 'x',
      key: 'x',
      size: 0,
      modifiedAt: null,
      etag: null,
      storageClass: null,
    });
  });
});

describe('copySource', () => {
  it('percent-encodes each segment but keeps the slashes', () => {
    expect(copySource('media', 'photos/my cat #1.jpg')).toBe('media/photos/my%20cat%20%231.jpg');
  });
});

describe('isBatchDeleteUnsupported', () => {
  it('recognises a provider that wants Content-MD5 or rejects checksum headers', () => {
    expect(
      isBatchDeleteUnsupported(
        new StorageError('Missing required header for this request: Content-Md5', 400),
      ),
    ).toBe(true);
    expect(
      isBatchDeleteUnsupported(new StorageError('x-amz-checksum-crc32 not supported', 400)),
    ).toBe(true);
  });

  it('does not swallow other failures', () => {
    expect(isBatchDeleteUnsupported(new StorageError('Access Denied', 403))).toBe(false);
    expect(isBatchDeleteUnsupported(new StorageError('Bad Request', 400))).toBe(false);
  });
});
