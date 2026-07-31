import { describe, it, expect } from 'vitest';
import { normalizeRemotePath, parentOf, SftpError } from './sftp.js';

describe('normalizeRemotePath', () => {
  it('keeps a plain absolute path', () => {
    expect(normalizeRemotePath('/var/www/html')).toBe('/var/www/html');
  });

  it('collapses redundant separators and dot segments', () => {
    expect(normalizeRemotePath('/var//www/./html')).toBe('/var/www/html');
  });

  it('strips a trailing slash but preserves the root', () => {
    expect(normalizeRemotePath('/var/www/')).toBe('/var/www');
    expect(normalizeRemotePath('/')).toBe('/');
  });

  it('resolves .. within the path', () => {
    expect(normalizeRemotePath('/var/www/../log')).toBe('/var/log');
  });

  it('clamps traversal at the root rather than escaping it', () => {
    expect(normalizeRemotePath('/../../../etc/passwd')).toBe('/etc/passwd');
    expect(normalizeRemotePath('/..')).toBe('/');
  });

  it('rejects relative paths', () => {
    expect(() => normalizeRemotePath('etc/passwd')).toThrow(SftpError);
    expect(() => normalizeRemotePath('../etc')).toThrow(SftpError);
  });

  it('rejects empty input and null bytes', () => {
    expect(() => normalizeRemotePath('')).toThrow(SftpError);
    expect(() => normalizeRemotePath('/etc/passwd\0.png')).toThrow(SftpError);
  });

  it('reports a 400 for bad input', () => {
    expect.assertions(1);
    try {
      normalizeRemotePath('relative');
    } catch (err) {
      expect((err as SftpError).statusCode).toBe(400);
    }
  });
});

describe('parentOf', () => {
  it('returns null at the root', () => {
    expect(parentOf('/')).toBeNull();
  });

  it('returns the containing directory', () => {
    expect(parentOf('/var/www/html')).toBe('/var/www');
    expect(parentOf('/etc')).toBe('/');
  });
});
