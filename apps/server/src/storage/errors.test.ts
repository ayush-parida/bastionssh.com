import { describe, it, expect } from 'vitest';
import { StorageError, toStorageError } from './errors.js';

function sdkError(name: string, httpStatusCode?: number, message = `${name} happened`) {
  const err = new Error(message);
  err.name = name;
  (err as Error & { $metadata?: unknown }).$metadata = { httpStatusCode };
  return err;
}

describe('toStorageError', () => {
  it('passes an existing StorageError through untouched', () => {
    const original = new StorageError('nope', 418);
    expect(toStorageError(original)).toBe(original);
  });

  it('maps missing buckets and keys to 404', () => {
    expect(toStorageError(sdkError('NoSuchBucket', 404)).statusCode).toBe(404);
    expect(toStorageError(sdkError('NoSuchKey', 404)).statusCode).toBe(404);
    expect(toStorageError(sdkError('NotFound', 404)).statusCode).toBe(404);
  });

  it('maps credential problems to 403', () => {
    for (const name of ['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch']) {
      expect(toStorageError(sdkError(name, 403)).statusCode).toBe(403);
    }
  });

  it('maps bucket conflicts to 409 and explains a non-empty bucket', () => {
    expect(toStorageError(sdkError('BucketAlreadyExists', 409)).statusCode).toBe(409);
    const notEmpty = toStorageError(sdkError('BucketNotEmpty', 409));
    expect(notEmpty.statusCode).toBe(409);
    expect(notEmpty.message).toMatch(/not empty/i);
  });

  it('maps network failures to 502 even when Node hides the code in `cause`', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9000'), {
      code: 'ECONNREFUSED',
    });
    const outer = new Error('request failed', { cause: inner });
    const mapped = toStorageError(outer);
    expect(mapped.statusCode).toBe(502);
    expect(mapped.message).toContain('ECONNREFUSED');
  });

  it('maps timeouts to 504', () => {
    expect(toStorageError(sdkError('TimeoutError')).statusCode).toBe(504);
  });

  it('keeps an unrecognised 4xx status from the provider', () => {
    expect(toStorageError(sdkError('InvalidRequest', 400)).statusCode).toBe(400);
  });

  it('treats anything else as an upstream failure', () => {
    expect(toStorageError(sdkError('InternalError', 500)).statusCode).toBe(502);
    expect(toStorageError(new Error('boom')).statusCode).toBe(502);
    expect(toStorageError(undefined, 'fallback text').message).toBe('fallback text');
  });
});
