import { createHash } from 'crypto';
import ssh2 from 'ssh2';
import type { ParsedKey } from 'ssh2';

const { utils } = ssh2;

type KeyType = 'rsa' | 'ed25519' | 'ecdsa';

/** Thrown when a supplied private key cannot be used by ssh2. */
export class InvalidKeyError extends Error {
  readonly statusCode = 400;
}

/** SHA256 over the SSH wire-format public key blob, matching `ssh-keygen -lf`. */
function fingerprintOf(key: ParsedKey): string {
  const hash = createHash('sha256').update(key.getPublicSSH()).digest('base64');
  return `SHA256:${hash.replace(/=+$/, '')}`;
}

function toKeyType(sshType: string): KeyType | null {
  if (sshType === 'ssh-rsa') return 'rsa';
  if (sshType === 'ssh-ed25519') return 'ed25519';
  if (sshType.startsWith('ecdsa-sha2-')) return 'ecdsa';
  return null;
}

/**
 * Generate an OpenSSH-format key pair: the private key is one ssh2 can parse
 * and the public key is a one-line `ssh-xxx AAAA...` entry for authorized_keys.
 */
export async function generateKeyPair(type: KeyType): Promise<{
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}> {
  const pair =
    type === 'rsa'
      ? utils.generateKeyPairSync('rsa', { bits: 4096 })
      : type === 'ecdsa'
        ? utils.generateKeyPairSync('ecdsa', { bits: 256 })
        : utils.generateKeyPairSync('ed25519');

  const parsed = utils.parseKey(pair.private);
  if (parsed instanceof Error) throw parsed;

  return {
    privateKey: pair.private,
    publicKey: pair.public,
    fingerprint: fingerprintOf(parsed),
  };
}

/**
 * Parse an imported private key the same way ssh2 will at connect time, so an
 * unusable key is rejected up front rather than failing on first connection.
 */
export function describePrivateKey(pem: string): {
  type: KeyType;
  publicKey: string;
  fingerprint: string;
} {
  const result = utils.parseKey(pem);
  const parsed = Array.isArray(result) ? result[0] : result;
  if (!parsed) throw new InvalidKeyError('Could not parse private key');
  if (parsed instanceof Error) {
    throw new InvalidKeyError(
      /passphrase/i.test(parsed.message)
        ? 'Passphrase-protected keys are not supported; remove the passphrase first'
        : `Could not parse private key: ${parsed.message}`,
    );
  }
  if (!parsed.isPrivateKey()) {
    throw new InvalidKeyError('Expected a private key, got a public key');
  }

  const type = toKeyType(parsed.type);
  if (!type) throw new InvalidKeyError(`Unsupported key type: ${parsed.type}`);

  const publicKey = `${parsed.type} ${parsed.getPublicSSH().toString('base64')}${
    parsed.comment ? ` ${parsed.comment}` : ''
  }`;
  return { type, publicKey, fingerprint: fingerprintOf(parsed) };
}
