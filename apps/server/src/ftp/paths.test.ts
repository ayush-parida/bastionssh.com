import { describe, it, expect } from 'vitest';
import { assertSafeHost, baseName, joinPath, normalizeRemotePath, parentOf } from './paths.js';
import { FtpError } from './errors.js';

describe('normalizeRemotePath', () => {
  it('accepts absolute paths and strips trailing slashes', () => {
    expect(normalizeRemotePath('/var/www/')).toBe('/var/www');
    expect(normalizeRemotePath('/')).toBe('/');
    expect(normalizeRemotePath('//')).toBe('/');
  });

  it('collapses dot segments without escaping the root', () => {
    expect(normalizeRemotePath('/a/./b/../c')).toBe('/a/c');
    expect(normalizeRemotePath('/../../etc')).toBe('/etc');
  });

  it('rejects relative paths, empty input, null bytes and line breaks', () => {
    for (const bad of ['', 'relative', '/a\0b', '/a\r\nDELE b']) {
      expect(() => normalizeRemotePath(bad)).toThrow(FtpError);
    }
  });
});

describe('path helpers', () => {
  it('parentOf returns null at the root', () => {
    expect(parentOf('/')).toBeNull();
    expect(parentOf('/a')).toBe('/');
    expect(parentOf('/a/b')).toBe('/a');
  });

  it('joins without doubling the root slash', () => {
    expect(joinPath('/', 'x')).toBe('/x');
    expect(joinPath('/a', 'x')).toBe('/a/x');
    expect(baseName('/a/b.txt')).toBe('b.txt');
  });
});

describe('assertSafeHost', () => {
  it('accepts hostnames and IPs, lowercased and trimmed', () => {
    expect(assertSafeHost(' FTP.Example.com ')).toBe('ftp.example.com');
    expect(assertSafeHost('192.168.1.10')).toBe('192.168.1.10');
    expect(assertSafeHost('::1')).toBe('::1');
  });

  it('refuses URLs, credentials, whitespace and metadata addresses', () => {
    for (const bad of [
      '',
      'ftp://host',
      'user@host',
      'host/path',
      'ho st',
      '-bad-.com',
      '169.254.169.254',
      'metadata.google.internal',
    ]) {
      expect(() => assertSafeHost(bad)).toThrow(FtpError);
    }
  });
});
