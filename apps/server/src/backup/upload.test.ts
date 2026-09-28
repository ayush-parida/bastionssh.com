import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Readable } from 'stream';
import { config } from '../config/index.js';

const fake = vi.hoisted(() => ({
  putObject: vi.fn(async (_c: unknown, _b: string, _k: string, _body: Readable, _t?: string) => {}),
}));

vi.mock('../db/index.js', () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ get: () => ({ orgId: 'org-1' }) }) }) }) }),
}));
vi.mock('../storage/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage/index.js')>()),
  resolveConnection: async () => ({ connection: {}, client: {} }),
  ops: { putObject: fake.putObject },
}));

import { backupObjectKey, uploadBackup } from './upload.js';
import { backupKey, decryptFile, isEncryptedFile } from './crypt.js';

describe('uploadBackup', () => {
  it('uploads only an encrypted copy, which the server key opens', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-upload-'));
    try {
      const file = path.join(tmp, 'smt-20260928T031500Z-manual.db');
      const plain = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(200_000, 'secret-row ')]);
      fs.writeFileSync(file, plain);
      let uploaded = Buffer.alloc(0);
      fake.putObject.mockImplementationOnce(async (_c, _b, _k, body) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(chunk as Buffer);
        uploaded = Buffer.concat(chunks);
      });

      await uploadBackup(file, path.basename(file), { connectionId: 'c1', bucket: 'offsite', prefix: 'smt' });

      const [, bucket, key, , type] = fake.putObject.mock.calls[0]!;
      expect(bucket).toBe('offsite');
      expect(key).toBe('smt/smt-20260928T031500Z-manual.db.enc');
      expect(key).toBe(backupObjectKey('smt', path.basename(file)));
      expect(type).toBe('application/octet-stream');
      expect(uploaded.includes('SQLite format 3')).toBe(false);
      expect(uploaded.includes('secret-row')).toBe(false);

      const sealed = path.join(tmp, 'copy.enc');
      fs.writeFileSync(sealed, uploaded);
      expect(isEncryptedFile(sealed)).toBe(true);
      const opened = path.join(tmp, 'opened.db');
      await decryptFile(sealed, opened, backupKey(config.encryptionKey));
      expect(fs.readFileSync(opened).equals(plain)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
