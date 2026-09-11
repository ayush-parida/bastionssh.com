import { and, eq } from 'drizzle-orm';
import type { S3Client } from '@aws-sdk/client-s3';
import type { StorageProvider } from '@smt/shared';
import { getDb } from '../db/index.js';
import { storageConnections } from '../db/schema.js';
import { vault } from '../vault/index.js';
import { createClient } from './client.js';
import { StorageError } from './errors.js';

export * from './errors.js';
export * from './keys.js';
export * as ops from './ops.js';

export type StorageConnectionRow = typeof storageConnections.$inferSelect;

/**
 * One client per connection, reused across requests so the HTTP agent keeps
 * its sockets warm. The *pending* build is what gets cached, so two requests
 * that miss at the same moment share one client instead of leaking one.
 * `updatedAt` is part of the cache check, so editing a connection rebuilds its
 * client on the next request.
 */
interface CachedClient {
  updatedAt: string;
  client: Promise<S3Client>;
}

const clients = new Map<string, CachedClient>();

export function evictConnection(id: string): void {
  const cached = clients.get(id);
  if (!cached) return;
  clients.delete(id);
  void cached.client.then((client) => client.destroy()).catch(() => {});
}

async function buildClient(connection: StorageConnectionRow): Promise<S3Client> {
  const secret = await vault.decrypt(connection.encryptedSecretAccessKey, connection.id);
  return createClient(
    {
      provider: connection.provider as StorageProvider,
      endpoint: connection.endpoint,
      region: connection.region,
      accessKeyId: connection.accessKeyId,
      forcePathStyle: connection.forcePathStyle,
    },
    secret,
  );
}

/** Load a connection scoped to the caller's org and hand back a ready client. */
export async function resolveConnection(
  orgId: string,
  id: string,
): Promise<{ connection: StorageConnectionRow; client: S3Client }> {
  const connection = getDb()
    .select()
    .from(storageConnections)
    .where(and(eq(storageConnections.id, id), eq(storageConnections.orgId, orgId)))
    .get();
  if (!connection) throw new StorageError('Storage connection not found', 404);

  let cached = clients.get(id);
  if (cached && cached.updatedAt !== connection.updatedAt) {
    evictConnection(id);
    cached = undefined;
  }
  if (!cached) {
    const pending = buildClient(connection);
    cached = { updatedAt: connection.updatedAt, client: pending };
    clients.set(id, cached);
    // A failed build must not be served to the next caller
    pending.catch(() => {
      if (clients.get(id) === cached) clients.delete(id);
    });
  }
  return { connection, client: await cached.client };
}
