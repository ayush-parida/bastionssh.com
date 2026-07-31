import { getDb } from '../db/index.js';
import { servers, sshKeys } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { vault } from '../vault/index.js';

export interface ResolvedServerAuth {
  server: typeof servers.$inferSelect;
  auth: { privateKey?: string; password?: string };
}

export class CredentialError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'CredentialError';
  }
}

/**
 * Load a server scoped to the caller's org and decrypt whichever credential it
 * is configured with — the default SSH key if set, otherwise the stored password.
 */
export async function resolveServerAuth(
  orgId: string,
  serverId: string,
  keyId?: string,
): Promise<ResolvedServerAuth> {
  const db = getDb();

  const server = db
    .select()
    .from(servers)
    .where(and(eq(servers.id, serverId), eq(servers.orgId, orgId)))
    .get();
  if (!server) throw new CredentialError('Server not found', 404);

  const effectiveKeyId = keyId ?? server.defaultKeyId;

  if (effectiveKeyId) {
    const key = db
      .select()
      .from(sshKeys)
      .where(and(eq(sshKeys.id, effectiveKeyId), eq(sshKeys.orgId, orgId)))
      .get();
    if (!key) throw new CredentialError('SSH key not found', 404);
    return { server, auth: { privateKey: await vault.decrypt(key.encryptedPrivateKey, key.id) } };
  }

  if (server.encryptedPassword) {
    return { server, auth: { password: await vault.decrypt(server.encryptedPassword, server.id) } };
  }

  throw new CredentialError('No authentication method configured for this server', 400);
}
