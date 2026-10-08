import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { abortEventStreams } from '../api/sse.js';
import type { FolderWalker, WalkEntry } from '../archive/index.js';
import { getDb } from '../db/index.js';
import { storageConnections } from '../db/schema.js';
import { StorageError, toStorageError } from './errors.js';

/**
 * Object Storage → Download folder: a prefix walked as a folder tree for the
 * archive engine (archive/), with the `/` delimiter the object browser uses —
 * common prefixes are folders, a zero-byte `prefix/` marker is the folder
 * itself (so an empty folder still shows up), every other key under the prefix
 * is a file. Keys are only ever read, so nothing is rewritten here: a segment
 * the archive cannot hold (`..`, an empty name from `a//b`) is left out by the
 * engine and listed in `_skipped.txt`.
 */

/** Keys per ListObjectsV2 page (S3's own maximum). */
const LIST_PAGE = 1000;

/** The cheap pre-estimate stops after this many objects, or this long, and says "at least". */
export const ESTIMATE_MAX_OBJECTS = 10_000;
export const ESTIMATE_MAX_MS = 5_000;

export interface PrefixWalkerOptions {
  /**
   * A folder listing stops growing past this many entries: the archive is cut
   * at SMT_FOLDER_DOWNLOAD_MAX_FILES anyway, so a prefix holding millions of
   * keys is not held in memory first.
   */
  maxEntries: number;
}

/** The name of a key or common prefix inside the folder `prefix` (one segment; a prefix's trailing `/` dropped). */
function childName(prefix: string, keyOrPrefix: string): string {
  const rest = keyOrPrefix.slice(prefix.length);
  return rest.endsWith('/') ? rest.slice(0, -1) : rest;
}

export function prefixWalker(client: S3Client, bucket: string, opts: PrefixWalkerOptions): FolderWalker {
  // Closing the walker (archive done or abandoned) stops a listing still in flight
  const closed = new AbortController();

  return {
    async list(prefix: string): Promise<WalkEntry[]> {
      const entries: WalkEntry[] = [];
      let found = false;
      let token: string | undefined;
      do {
        let page;
        try {
          page = await client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: prefix || undefined,
              Delimiter: '/',
              MaxKeys: LIST_PAGE,
              ContinuationToken: token,
            }),
            { abortSignal: closed.signal },
          );
        } catch (err) {
          throw toStorageError(err, 'Could not list objects');
        }
        for (const p of page.CommonPrefixes ?? []) {
          if (!p.Prefix?.startsWith(prefix)) continue;
          found = true;
          entries.push({ name: childName(prefix, p.Prefix), ref: p.Prefix, type: 'dir', size: 0 });
        }
        for (const o of page.Contents ?? []) {
          if (!o.Key?.startsWith(prefix)) continue;
          found = true;
          // The folder's own marker: it makes the folder exist, it is not a file in it
          if (o.Key === prefix) continue;
          entries.push({
            name: childName(prefix, o.Key),
            ref: o.Key,
            type: 'file',
            size: o.Size ?? 0,
            ...(o.LastModified && { mtime: o.LastModified }),
          });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token && entries.length <= opts.maxEntries);
      // S3 has no folders: a prefix nothing is stored under is a typo or a folder deleted meanwhile
      if (!found && prefix !== '') throw new StorageError(`Nothing is stored under "${prefix}"`, 404);
      return entries;
    },

    async open(entry: WalkEntry, signal: AbortSignal): Promise<Readable> {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: entry.ref }), {
          abortSignal: AbortSignal.any([signal, closed.signal]),
        });
        if (!out.Body) throw new StorageError('Object has no body', 502);
        // In Node the SDK body is an IncomingMessage with stream mixins — a Readable
        return out.Body as unknown as Readable;
      } catch (err) {
        throw toStorageError(err, 'Could not download object');
      }
    },

    close(): void {
      closed.abort(new Error('Folder download finished'));
    },
  };
}

export interface PrefixEstimate {
  files: number;
  /** Subfolders under the prefix (from the keys' paths): the file limit counts them too. */
  folders: number;
  bytes: number;
  complete: boolean;
}

/**
 * Count the objects under a prefix and add up their sizes with a flat
 * listing (no delimiter, 1000 keys a request), stopping after `maxObjects`
 * or `maxMs`; `complete` says whether it got to the end. Folder markers
 * (keys ending in `/`) are not counted as files: the archive never holds them
 * as files, only as the folders `folders` counts.
 */
export async function estimatePrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
  limits: { maxObjects?: number; maxMs?: number } = {},
): Promise<PrefixEstimate> {
  const maxObjects = limits.maxObjects ?? ESTIMATE_MAX_OBJECTS;
  const deadline = AbortSignal.timeout(limits.maxMs ?? ESTIMATE_MAX_MS);
  let files = 0;
  let bytes = 0;
  // Every folder a key sits in below the prefix is an archive entry of its own
  const folders = new Set<string>();
  const result = (complete: boolean): PrefixEstimate => ({ files, folders: folders.size, bytes, complete });
  let token: string | undefined;
  do {
    let page;
    try {
      page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix || undefined,
          MaxKeys: LIST_PAGE,
          ContinuationToken: token,
        }),
        { abortSignal: deadline },
      );
    } catch (err) {
      // Out of time: what was counted so far is the answer
      if (deadline.aborted) return result(false);
      throw toStorageError(err, 'Could not list objects');
    }
    for (const o of page.Contents ?? []) {
      if (!o.Key) continue;
      const rest = o.Key.slice(prefix.length);
      for (let i = rest.indexOf('/'); i > 0; i = rest.indexOf('/', i + 1)) folders.add(rest.slice(0, i));
      if (o.Key.endsWith('/')) continue;
      files++;
      bytes += o.Size ?? 0;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (token && (files >= maxObjects || deadline.aborted)) return result(false);
  } while (token);
  return result(true);
}

/**
 * End a user's storage folder downloads — in one org when `orgId` is given,
 * sparing the connections in `keepConnectionIds` (those they can still see).
 * Folder downloads of the other viewers share the stream feature, so only
 * storage connections are looked at.
 */
export function abortStorageFolderDownloads(
  userId: string,
  scope: { orgId?: string; keepConnectionIds?: Iterable<string> } = {},
): number {
  const keep = new Set(scope.keepConnectionIds ?? []);
  const query = getDb().select({ id: storageConnections.id }).from(storageConnections);
  const rows = scope.orgId ? query.where(eq(storageConnections.orgId, scope.orgId)).all() : query.all();
  const lost = rows.map((r) => r.id).filter((id) => !keep.has(id));
  if (lost.length === 0) return 0;
  return abortEventStreams(userId, 'files', { orgId: scope.orgId, onlyResourceIds: lost });
}
