import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from '../config/index.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // 96-bit IV — standard for GCM
const TAG_LEN = 16; // 128-bit auth tag

let masterKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (masterKey) return masterKey;
  const raw = Buffer.from(config.encryptionKey, 'base64');
  if (raw.length < 32) throw new Error('SMT_ENCRYPTION_KEY must be at least 32 bytes (base64)');
  masterKey = raw.subarray(0, 32);
  return masterKey;
}

/**
 * Encrypt plaintext with AES-256-GCM. The resourceId is bound as additional
 * authenticated data (AAD) to prevent ciphertext swap attacks.
 *
 * Output format (base64): IV (12 bytes) || tag (16 bytes) || ciphertext
 */
async function encrypt(plaintext: string, resourceId: string): Promise<string> {
  const key = getMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(resourceId, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt a vault-encrypted value. The resourceId must match the one used at encryption.
 */
async function decrypt(encoded: string, resourceId: string): Promise<string> {
  const key = getMasterKey();
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAAD(Buffer.from(resourceId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export const vault = { encrypt, decrypt };
