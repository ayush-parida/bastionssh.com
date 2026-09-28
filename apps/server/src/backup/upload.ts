import { eq } from 'drizzle-orm';
import { config } from '../config/index.js';
import { getDb } from '../db/index.js';
import { storageConnections } from '../db/schema.js';
import { assertBucketParam, normalizeKey, normalizePrefix, ops, resolveConnection, StorageError } from '../storage/index.js';
import { backupKey, encryptedStream } from './crypt.js';

export interface BackupUploadTarget {
  connectionId: string;
  bucket: string;
  prefix: string;
}

/** The object key a backup is stored under (encrypted, hence `.enc`). */
export function backupObjectKey(prefix: string, name: string): string {
  return normalizeKey(`${normalizePrefix(prefix)}${name}.enc`);
}

/**
 * Copy a finished backup to an object-storage connection registered in the
 * app. The connection id comes from the operator's environment, not from a
 * request, so it is looked up in whichever org registered it. Only uploads —
 * pruning what is already in the bucket is left to a lifecycle rule there.
 *
 * Encrypted with the backup key (crypt.ts): members of that org, viewers
 * included, can read the bucket through the Storage browser, and must not
 * get the whole instance's database that way.
 */
export async function uploadBackup(file: string, name: string, target: BackupUploadTarget): Promise<void> {
  const row = getDb()
    .select({ orgId: storageConnections.orgId })
    .from(storageConnections)
    .where(eq(storageConnections.id, target.connectionId))
    .get();
  if (!row) throw new StorageError(`Storage connection ${target.connectionId} not found`, 404);

  const { client } = await resolveConnection(row.orgId, target.connectionId);
  const bucket = assertBucketParam(target.bucket);
  const key = backupObjectKey(target.prefix, name);
  await ops.putObject(client, bucket, key, encryptedStream(file, backupKey(config.encryptionKey)), 'application/octet-stream');
}
