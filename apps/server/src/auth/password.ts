import argon2 from 'argon2';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Spend as long as a real check when there is no hash to check against (no
 * such account, or no password set), so response time does not tell an
 * attacker which addresses have accounts. Always false.
 */
export async function verifyAgainstNothing(password: string): Promise<false> {
  dummyHash ??= hashPassword('not-a-real-password-hash-input');
  await verifyPassword(password, await dummyHash);
  return false;
}
