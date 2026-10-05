import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { envFileMasker, MASK, secretMasker } from './mask.js';

describe('masking .env values', () => {
  it('replaces every exact occurrence of values of 6 characters or more', () => {
    const mask = secretMasker(['s3cret-token', 'token', 'prod', 'hunter2']);
    expect(MASK).toBe('••••');
    expect(mask('a=s3cret-token b=s3cret-token c=hunter2 env=prod t=token')).toBe('a=•••• b=•••• c=•••• env=prod t=token');
    expect(secretMasker([])('nothing')).toBe('nothing');
  });

  it('masks a value that contains another whole', () => {
    expect(secretMasker(['abcdef', 'abcdef123456'])('key abcdef123456 and abcdef')).toBe('key •••• and ••••');
  });

  it('masks each line of a multi-line value, printed one log line at a time', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nAbC\n-----END PRIVATE KEY-----';
    const mask = secretMasker([key]);
    expect(mask(key)).toBe('••••');
    expect(['crash: -----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'AbC'].map(mask)).toEqual(['crash: ••••', '••••', 'AbC']);
    // Lines are held to the same minimum length; a short value is not masked by its lines either
    expect(secretMasker(['abcdef\nxy'])('abcdef\nxy abcdef xy')).toBe('•••• •••• xy');
    expect(secretMasker(['ab\ncd'])('ab\ncd')).toBe('ab\ncd');
  });

  it('masks the JSON-escaped form of a value an app logs inside JSON', () => {
    const mask = secretMasker(['pa"ss\\word', 'line1\nline2']);
    expect(mask(JSON.stringify({ password: 'pa"ss\\word', cert: 'line1\nline2' }))).toBe('{"password":"••••","cert":"••••"}');
  });

  it('follows the env file as it changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-mask-'));
    const file = path.join(dir, '.env');
    try {
      const mask = envFileMasker(file);
      expect(mask('no file yet: value1234')).toBe('no file yet: value1234');
      fs.writeFileSync(file, 'A="value1234"\n# value9999 in a comment is no value\n');
      expect(mask('value1234 value9999')).toBe('•••• value9999');
      // A quoted value with an escaped line break is masked as the text it stands for
      fs.writeFileSync(file, 'A="value1234"\nC="multi\\nline"\n');
      expect(mask('value1234 multi\nline')).toBe('•••• ••••');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
