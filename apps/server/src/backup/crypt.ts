import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

/**
 * Encryption of backups copied off the instance. An object-storage bucket is
 * readable by every member of the connection's organization through the
 * Storage browser (viewers included), and a backup holds every organization's
 * accounts and pending invites — so what leaves the instance is sealed with a
 * key derived from SMT_ENCRYPTION_KEY. Restoring one therefore needs that key,
 * as decrypting the credentials inside it always did.
 *
 * Format: MAGIC (8) || IV (12) || AES-256-GCM ciphertext || tag (16).
 * Kept free of config so the restore CLI can use it with a bare environment.
 */

export const ENCRYPTED_MAGIC = Buffer.from('SMTBAK1\n', 'latin1');
const IV_LEN = 12;
const TAG_LEN = 16;

/** The backup key, derived from the vault master key (base64, as in SMT_ENCRYPTION_KEY). */
export function backupKey(encryptionKey: string): Buffer {
  const raw = Buffer.from(encryptionKey, 'base64');
  if (raw.length < 32) throw new Error('SMT_ENCRYPTION_KEY must be at least 32 bytes (base64)');
  return Buffer.from(hkdfSync('sha256', raw.subarray(0, 32), Buffer.alloc(0), 'bastionssh-db-backup-v1', 32));
}

/** A stream of `file`, encrypted. */
export function encryptedStream(file: string, key: Buffer): Readable {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  async function* sealed() {
    yield Buffer.concat([ENCRYPTED_MAGIC, iv]);
    for await (const chunk of fs.createReadStream(file)) {
      const out = cipher.update(chunk as Buffer);
      if (out.length) yield out;
    }
    yield Buffer.concat([cipher.final(), cipher.getAuthTag()]);
  }
  return Readable.from(sealed());
}

export function isEncryptedFile(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(ENCRYPTED_MAGIC.length);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return n === head.length && head.equals(ENCRYPTED_MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

/** Decrypt an encrypted backup `file` to `dest`. Rejects on a wrong key or a tampered file. */
export async function decryptFile(file: string, dest: string, key: Buffer): Promise<void> {
  const size = fs.statSync(file).size;
  const bodyStart = ENCRYPTED_MAGIC.length + IV_LEN;
  if (size < bodyStart + TAG_LEN) throw new Error('Encrypted backup is truncated');
  const fd = fs.openSync(file, 'r');
  const iv = Buffer.alloc(IV_LEN);
  const tag = Buffer.alloc(TAG_LEN);
  try {
    fs.readSync(fd, iv, 0, IV_LEN, ENCRYPTED_MAGIC.length);
    fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    fs.closeSync(fd);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      // createReadStream's end is inclusive; an empty body has nothing to read
      size - TAG_LEN > bodyStart
        ? fs.createReadStream(file, { start: bodyStart, end: size - TAG_LEN - 1 })
        : Readable.from([]),
      decipher,
      fs.createWriteStream(dest, { mode: 0o600 }),
    );
  } catch (err) {
    fs.rmSync(dest, { force: true });
    const msg = (err as Error).message;
    throw new Error(
      /auth/i.test(msg) ? 'Could not decrypt the backup: wrong SMT_ENCRYPTION_KEY, or the file was altered' : msg,
    );
  }
}
