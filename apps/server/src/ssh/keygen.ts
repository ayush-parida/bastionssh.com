import { generateKeyPairSync, createPublicKey } from 'crypto';
import { createHash } from 'crypto';

type KeyType = 'rsa' | 'ed25519' | 'ecdsa';

export async function generateKeyPair(type: KeyType): Promise<{
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}> {
  let pair: { privateKey: string; publicKey: string };

  if (type === 'rsa') {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 4096,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    pair = { privateKey, publicKey };
  } else if (type === 'ed25519') {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    pair = { privateKey, publicKey };
  } else {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    pair = { privateKey, publicKey };
  }

  const pubKeyObj = createPublicKey(pair.publicKey);
  const derBuf = pubKeyObj.export({ type: 'spki', format: 'der' });
  const fingerprint = createHash('sha256').update(derBuf).digest('base64');

  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    fingerprint: `SHA256:${fingerprint}`,
  };
}
