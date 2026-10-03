import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { KeyRotation, KeyRotationStatus, KeyRotationStep, KeyType } from '@smt/shared';
import { getDb } from '../db/index.js';
import { cloudAccounts, ftpConnections, keyRotations, servers, sshKeys } from '../db/schema.js';
import { vault } from '../vault/index.js';
import { auditAs, type AuditActor } from '../audit/index.js';
import { execOnServer } from './broker.js';
import { generateKeyPair } from './keygen.js';
import { evictServer } from './sftp.js';
import { evictDockerServer } from '../docker/index.js';
import { evictKubeServer } from '../kube/index.js';
import { HostKeyMismatchError, type SshTarget } from './host-keys.js';
import type { JumpOptions } from './jump.js';
import logger from '../logger.js';

/**
 * SSH key rotation for a key-authenticated server:
 *
 * 1. prepare    — generate a new key pair (kept in memory until step 4);
 * 2. install    — over the OLD key, append the new public key to
 *                 ~/.ssh/authorized_keys, tagged `bastionssh-key-<id>`;
 * 3. verify     — log in with the NEW key alone, in a fresh connection;
 * 4. switch     — save the new key and point the server at it;
 * 5. remove_old — over the NEW key, delete the old key's lines;
 * 6. retire     — mark the old key retired once no server uses it.
 *
 * Any failure puts things back: until step 4 the server is on the old key and
 * the new line is removed again (over the old key). A failure in step 5 only
 * switches back when the old key provably still works; otherwise the server
 * stays on the new key, which step 3 showed works. The server is never left
 * pointing at a key it does not accept.
 *
 * All connections go through execOnServer, so host key verification applies.
 * authorized_keys is edited by small POSIX sh scripts (below) sent on stdin;
 * they only ever touch lines carrying the exact key blob in question.
 */

/** Shown when the app restarts in the middle of a rotation. */
const INTERRUPTED_MESSAGE =
  "The app restarted during this rotation. Check the server's ~/.ssh/authorized_keys and which key it uses.";

const SCRIPT_TIMEOUT_MS = 30_000;
const MAX_ERROR_LENGTH = 500;
export const VERIFY_TOKEN = 'bastionssh-key-ok';

/** Rotations running in this process, by server id. */
const running = new Set<string>();

export class KeyRotationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'KeyRotationError';
  }
}

// ── Remote scripts ───────────────────────────────────────────────────────────

/**
 * Shared prelude. `has KEY FILE` is true when a non-comment line of FILE has a
 * whitespace-separated field exactly equal to KEY (a base64 key blob), so key
 * options (`from="…" ssh-ed25519 AAAA…`) and CRLF line ends are handled and a
 * key is never matched by a prefix of another.
 *
 * Exit codes: 3 — the file cannot be edited safely, 4 — a required key is not
 * listed; in both cases nothing was changed. 5 — a write failed.
 */
const PRELUDE = `set -u
f="$HOME/.ssh/authorized_keys"
if [ -L "$f" ]; then echo "$f is a symbolic link; update it by hand" >&2; exit 3; fi
if [ ! -f "$f" ]; then echo "$f does not exist" >&2; exit 3; fi
if [ ! -O "$f" ]; then echo "$f is not owned by the login user" >&2; exit 3; fi
if [ ! -w "$f" ]; then echo "$f is not writable" >&2; exit 3; fi
has() {
  awk -v k="$1" '$0 !~ /^[ \\t]*#/ { for (i = 1; i <= NF; i++) { v = $i; sub(/\\r$/, "", v); if (v == k) { found = 1; exit } } } END { exit found ? 0 : 1 }' "$2"
}
`;

/**
 * Args: OLD_BLOB NEW_TYPE NEW_BLOB TAG. Appends `NEW_TYPE NEW_BLOB TAG` unless
 * NEW_BLOB is already listed. The old key's options (`from="…"`, `no-pty`, …)
 * are copied onto the new line, so a rotation never widens what the key may
 * do; a forced-command line is skipped, as our login cannot have used it.
 * Appending keeps the file's inode, owner and mode. Prints `added` or `present`.
 */
export const INSTALL_SCRIPT = `${PRELUDE}
has "$1" "$f" || { echo "the current key is not listed in $f" >&2; exit 4; }
if has "$3" "$f"; then echo present; exit 0; fi
opts=$(awk -v k="$1" '$0 !~ /^[ \\t]*#/ { for (i = 2; i <= NF; i++) { v = $i; sub(/\\r$/, "", v); if (v == k) { o = substr($0, 1, index($0, k) - 1); sub(/[ \\t]*[^ \\t]+[ \\t]+$/, "", o); sub(/^[ \\t]+/, "", o); if (tolower(o) !~ /(^|,)command=/) { print o; exit } } } }' "$f")
if [ -s "$f" ] && [ "$(tail -c 1 "$f" | wc -l | tr -d ' ')" = 0 ]; then printf '\\n' >> "$f" || exit 5; fi
if [ -n "$opts" ]; then
  printf '%s %s %s %s\\n' "$opts" "$2" "$3" "$4" >> "$f" || exit 5
else
  printf '%s %s %s\\n' "$2" "$3" "$4" >> "$f" || exit 5
fi
has "$3" "$f" || { echo "the new key could not be written to $f" >&2; exit 5; }
echo added
`;

/**
 * Args: REMOVE_BLOB KEEP_BLOB. Deletes every non-comment line listing
 * REMOVE_BLOB and nothing else; refuses unless KEEP_BLOB is listed, so the
 * login it runs over keeps working. The edit is written to a copy made with
 * `cp -p` (same mode) and renamed over the original, so the file is never
 * half-written. Prints `removed` or `absent`.
 */
export const REMOVE_SCRIPT = `${PRELUDE}
has "$2" "$f" || { echo "refusing to edit $f: the key that must stay is not listed" >&2; exit 4; }
if ! has "$1" "$f"; then echo absent; exit 0; fi
umask 077
tmp="$f.bastionssh.$$"
trap 'rm -f "$tmp"' EXIT
cp -p "$f" "$tmp" || exit 5
awk -v k="$1" '{ keep = 1; if ($0 !~ /^[ \\t]*#/) for (i = 1; i <= NF; i++) { v = $i; sub(/\\r$/, "", v); if (v == k) { keep = 0; break } } if (keep) print }' "$f" > "$tmp" || exit 5
has "$2" "$tmp" || { echo "refusing to edit $f: the edit would drop the key that must stay" >&2; exit 5; }
if has "$1" "$tmp"; then echo "the key could not be removed from $f" >&2; exit 5; fi
mv -f "$tmp" "$f" || exit 5
trap - EXIT
echo removed
`;

/** Characters a key blob, key type or tag may contain — nothing a shell treats specially. */
const SAFE_ARG = /^[A-Za-z0-9+/=@.:_-]+$/;

function shellArg(value: string): string {
  if (!SAFE_ARG.test(value)) throw new KeyRotationError('Refusing to pass an unexpected value to the server', 500);
  return `'${value}'`;
}

/**
 * The command line for a script sent on stdin. `sh -s` runs it under a POSIX
 * shell whatever the account's login shell is.
 */
export function scriptCommand(args: string[]): string {
  return ['sh', '-s', '--', ...args.map(shellArg)].join(' ');
}

/** The base64 key blob of a one-line public key (`type blob [comment]`). */
export function publicKeyBlob(publicKey: string): string {
  const blob = publicKey.trim().split(/\s+/)[1];
  if (!blob || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) {
    throw new KeyRotationError('The stored public key is not in the expected "type base64 comment" form');
  }
  return blob;
}

function publicKeyType(publicKey: string): string {
  return publicKey.trim().split(/\s+/)[0] ?? '';
}

/** A remote step failed. `unchanged` means the script reported it changed nothing. */
class RemoteStepError extends Error {
  constructor(
    message: string,
    readonly unchanged: boolean,
  ) {
    super(message);
    this.name = 'RemoteStepError';
  }
}

/**
 * The connection failed before any command ran: the host key was refused, the
 * login was rejected, or the handshake timed out (ssh2 tags errors with a `level`).
 */
function failedBeforeRunning(err: unknown): boolean {
  if (err instanceof HostKeyMismatchError) return true;
  const level = (err as { level?: string } | null)?.level;
  return level === 'client-authentication' || level === 'client-timeout';
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  return (lines[lines.length - 1] ?? '').trim();
}

async function runScript<T extends string>(
  target: SshTarget,
  privateKey: string,
  script: string,
  args: string[],
  outcomes: readonly T[],
  options: JumpOptions = {},
): Promise<T> {
  const result = await execOnServer(target, { privateKey }, scriptCommand(args), SCRIPT_TIMEOUT_MS, undefined, options, script);
  const outcome = lastLine(result.stdout) as T;
  if (result.exitCode === 0 && outcomes.includes(outcome)) return outcome;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  // 3 and 4 are raised before the file is touched
  throw new RemoteStepError(detail, result.exitCode === 3 || result.exitCode === 4);
}

/** Over `loginKey`: append the new key line unless it is already there. */
export function installKey(
  target: SshTarget,
  loginKey: string,
  oldBlob: string,
  newPublicKey: string,
  tag: string,
  options: JumpOptions = {},
) {
  return runScript(
    target,
    loginKey,
    INSTALL_SCRIPT,
    [oldBlob, publicKeyType(newPublicKey), publicKeyBlob(newPublicKey), tag],
    ['added', 'present'] as const,
    options,
  );
}

/** Over `loginKey`: delete the lines of `removeBlob`, only while `keepBlob` stays listed. */
export function removeKey(
  target: SshTarget,
  loginKey: string,
  removeBlob: string,
  keepBlob: string,
  options: JumpOptions = {},
) {
  return runScript(target, loginKey, REMOVE_SCRIPT, [removeBlob, keepBlob], ['removed', 'absent'] as const, options);
}

/** A fresh connection that authenticates with `privateKey` and nothing else. */
async function verifyLogin(target: SshTarget, privateKey: string, options: JumpOptions = {}) {
  const result = await execOnServer(target, { privateKey }, `echo ${VERIFY_TOKEN}`, SCRIPT_TIMEOUT_MS, undefined, options);
  if (result.exitCode !== 0 || !result.stdout.includes(VERIFY_TOKEN)) {
    throw new Error(`The login with the new key did not run the check command: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
  }
}

// ── Records ──────────────────────────────────────────────────────────────────

type RotationRow = typeof keyRotations.$inferSelect;

function parseWarnings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

export function rotationView(row: RotationRow): KeyRotation {
  return {
    id: row.id,
    batchId: row.batchId,
    serverId: row.serverId,
    serverName: row.serverName,
    oldKeyId: row.oldKeyId,
    oldFingerprint: row.oldFingerprint,
    newKeyId: row.newKeyId,
    newFingerprint: row.newFingerprint,
    status: row.status as KeyRotationStatus,
    step: row.step as KeyRotationStep | null,
    error: row.error,
    warnings: parseWarnings(row.warnings),
    oldKeyRetired: row.oldKeyRetired,
    startedBy: row.startedBy,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

function loadRotation(id: string): RotationRow | undefined {
  return getDb().select().from(keyRotations).where(eq(keyRotations.id, id)).get();
}

/** True while a rotation of this server is queued or running. */
export function rotationInProgress(serverId: string): boolean {
  if (running.has(serverId)) return true;
  return (
    getDb()
      .select({ id: keyRotations.id })
      .from(keyRotations)
      .where(and(eq(keyRotations.serverId, serverId), inArray(keyRotations.status, ['pending', 'running'])))
      .get() !== undefined
  );
}

type ServerRow = typeof servers.$inferSelect;

/**
 * Why this server cannot be rotated, or null when it can. Checked when a
 * rotation is requested and again when it starts.
 */
export function rotationBlocker(server: ServerRow): string | null {
  if (server.encryptedPassword) return 'uses password authentication, not an SSH key';
  if (!server.defaultKeyId) return 'has no SSH key assigned';
  return null;
}

/**
 * Queue a rotation of each server (already checked for access by the caller).
 * All-or-nothing: throws before recording anything when one cannot be rotated.
 * Synchronous from check to insert, so two requests cannot both queue a server.
 */
export function createRotations(
  orgId: string,
  serverRows: ServerRow[],
  startedBy: string,
  batchId: string | null,
): RotationRow[] {
  const db = getDb();
  const problems: string[] = [];
  const keys = new Map<string, typeof sshKeys.$inferSelect>();
  for (const server of serverRows) {
    const blocker = rotationBlocker(server);
    if (blocker) {
      problems.push(`${server.name} ${blocker}`);
      continue;
    }
    if (rotationInProgress(server.id)) {
      problems.push(`${server.name} is already being rotated`);
      continue;
    }
    const key = db
      .select()
      .from(sshKeys)
      .where(and(eq(sshKeys.id, server.defaultKeyId!), eq(sshKeys.orgId, orgId)))
      .get();
    if (!key) problems.push(`${server.name}: its SSH key was not found`);
    else keys.set(server.id, key);
  }
  if (problems.length) {
    const conflict = problems.every((p) => p.endsWith('already being rotated'));
    throw new KeyRotationError(`Cannot rotate: ${problems.join('; ')}`, conflict ? 409 : 400);
  }

  const rows = serverRows.map((server) => {
    const key = keys.get(server.id)!;
    return {
      id: nanoid(),
      orgId,
      batchId,
      serverId: server.id,
      serverName: server.name,
      oldKeyId: key.id,
      oldFingerprint: key.fingerprint,
      status: 'pending',
      startedBy,
    } satisfies typeof keyRotations.$inferInsert;
  });
  if (rows.length) db.insert(keyRotations).values(rows).run();
  return rows.map((r) => loadRotation(r.id)!);
}

/** On startup: nothing is running any more, so anything left open was cut short. */
export function markInterruptedRotations(): number {
  const result = getDb()
    .update(keyRotations)
    .set({ status: 'interrupted', error: INTERRUPTED_MESSAGE, finishedAt: new Date().toISOString() })
    .where(inArray(keyRotations.status, ['pending', 'running']))
    .run();
  if (result.changes > 0) logger.warn({ count: result.changes }, 'Marked unfinished SSH key rotations as interrupted');
  return result.changes;
}

// ── Running a rotation ───────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

/** Name of a key created by a rotation; the key name column is capped at 100 in the API. */
function rotatedKeyName(serverName: string): string {
  const suffix = ` (rotated ${new Date().toISOString().slice(0, 10)})`;
  return `${serverName.slice(0, 100 - suffix.length)}${suffix}`;
}

/**
 * Other servers of the org reaching the same account (host, port and user) on
 * the old key. They share this authorized_keys file, so removing the old key
 * there would lock them out. Behind a connectivity agent the host is only a
 * label (the agent always dials its own loopback), so there the agent stands
 * in for the host.
 */
function sharedAccountServers(server: ServerRow, oldKeyId: string): string[] {
  return getDb()
    .select({ name: servers.name })
    .from(servers)
    .where(
      and(
        eq(servers.orgId, server.orgId),
        ne(servers.id, server.id),
        server.agentId ? or(eq(servers.host, server.host), eq(servers.agentId, server.agentId)) : eq(servers.host, server.host),
        eq(servers.port, server.port),
        eq(servers.username, server.username),
        eq(servers.defaultKeyId, oldKeyId),
      ),
    )
    .all()
    .map((s) => s.name);
}

/**
 * Retire the key when nothing assigns it any more. A cloud account that gives
 * it to newly imported servers keeps it active. Synchronous, so no server can
 * be assigned the key between the check and the update.
 */
function retireIfUnused(
  orgId: string,
  key: typeof sshKeys.$inferSelect,
  actor: AuditActor,
  warnings: string[],
): boolean {
  const db = getDb();
  const inUse = db.select({ id: servers.id }).from(servers).where(eq(servers.defaultKeyId, key.id)).all();
  if (inUse.length > 0) return false;
  const accounts = db
    .select({ name: cloudAccounts.name })
    .from(cloudAccounts)
    .where(eq(cloudAccounts.defaultKeyId, key.id))
    .all();
  if (accounts.length > 0) {
    warnings.push(
      `The old key was not retired: cloud account(s) ${accounts.map((a) => a.name).join(', ')} still assign it to new servers.`,
    );
    return false;
  }
  // SFTP file connections log in with org keys too; a retired key would stop them
  const fileConnections = db
    .select({ name: ftpConnections.name })
    .from(ftpConnections)
    .where(and(eq(ftpConnections.sshKeyId, key.id), eq(ftpConnections.authMethod, 'key')))
    .all();
  if (fileConnections.length > 0) {
    warnings.push(
      `The old key was not retired: file connection(s) ${fileConnections.map((c) => c.name).join(', ')} still log in with it.`,
    );
    return false;
  }
  const result = db
    .update(sshKeys)
    .set({ retiredAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(and(eq(sshKeys.id, key.id), eq(sshKeys.orgId, orgId), isNull(sshKeys.retiredAt)))
    .run();
  if (result.changes > 0) {
    auditAs(actor, 'ssh_key.retire', 'ssh_key', key.id, key.name, { fingerprint: key.fingerprint });
  }
  return true;
}

export interface RotateOptions {
  /** Type of the new key; defaults to the old key's type. */
  type?: KeyType;
}

/**
 * Run a queued rotation to the end and return the final record. Never throws
 * for a failed rotation — the outcome is on the record — so a batch can carry
 * on with the next server.
 */
export async function runRotation(
  rotationId: string,
  actor: AuditActor,
  options: RotateOptions = {},
): Promise<KeyRotation> {
  const db = getDb();
  const initial = loadRotation(rotationId);
  if (!initial) throw new KeyRotationError('Rotation not found', 404);
  if (initial.status !== 'pending' || !initial.serverId) return rotationView(initial);
  const serverId = initial.serverId;
  if (running.has(serverId)) {
    db.update(keyRotations)
      .set({ status: 'failed', error: 'Another rotation of this server is running', finishedAt: new Date().toISOString() })
      .where(eq(keyRotations.id, rotationId))
      .run();
    return rotationView(loadRotation(rotationId)!);
  }
  running.add(serverId);
  try {
    return await performRotation(initial, serverId, actor, options);
  } catch (err) {
    // Only reached on an unexpected error (the steps record their own failures)
    logger.error({ err, rotationId, serverId }, 'SSH key rotation crashed');
    db.update(keyRotations)
      .set({ status: 'failed', error: errorMessage(err), finishedAt: new Date().toISOString() })
      .where(and(eq(keyRotations.id, rotationId), inArray(keyRotations.status, ['pending', 'running'])))
      .run();
    return rotationView(loadRotation(rotationId)!);
  } finally {
    running.delete(serverId);
  }
}

async function performRotation(
  initial: RotationRow,
  serverId: string,
  actor: AuditActor,
  options: RotateOptions,
): Promise<KeyRotation> {
  const db = getDb();
  const rotationId = initial.id;
  const warnings: string[] = [];
  // Any jump hop is audited under whoever asked for the rotation
  const hop: JumpOptions = { actorUserId: actor.userId };
  // Widened: enter() reassigns it, which narrowing cannot see
  let step = 'prepare' as KeyRotationStep;
  const update = (patch: Partial<typeof keyRotations.$inferInsert>) =>
    db.update(keyRotations).set(patch).where(eq(keyRotations.id, rotationId)).run();
  const enter = (next: KeyRotationStep) => {
    step = next;
    update({ step: next });
  };
  update({ status: 'running', step });

  // Known once prepared; the rollback needs them
  let target: SshTarget | undefined;
  let serverName = initial.serverName;
  let oldKey: typeof sshKeys.$inferSelect | undefined;
  let oldPrivate = '';
  let oldBlob = '';
  let newBlob = '';
  let newKeyId: string | undefined;
  let newPublicKey = '';
  let newPrivate = '';
  /** authorized_keys may hold the new key line. */
  let touched = false;
  /** The server row points at the new key. */
  let switched = false;

  const finish = (status: KeyRotationStatus, patch: Partial<typeof keyRotations.$inferInsert> = {}) => {
    update({ status, warnings: JSON.stringify(warnings), finishedAt: new Date().toISOString(), ...patch });
    return rotationView(loadRotation(rotationId)!);
  };

  try {
    const server = db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.orgId, initial.orgId)))
      .get();
    if (!server) throw new KeyRotationError('The server no longer exists');
    serverName = server.name;
    const blocker = rotationBlocker(server);
    if (blocker) throw new KeyRotationError(`The server ${blocker}`);
    if (server.defaultKeyId !== initial.oldKeyId) {
      throw new KeyRotationError('The server was assigned a different key after the rotation was requested');
    }
    oldKey = db
      .select()
      .from(sshKeys)
      .where(and(eq(sshKeys.id, initial.oldKeyId), eq(sshKeys.orgId, initial.orgId)))
      .get();
    if (!oldKey) throw new KeyRotationError('The current SSH key no longer exists');

    target = { id: server.id, host: server.host, port: server.port, username: server.username };
    oldPrivate = await vault.decrypt(oldKey.encryptedPrivateKey, oldKey.id);
    oldBlob = publicKeyBlob(oldKey.publicKey);
    const pair = await generateKeyPair(options.type ?? (oldKey.type as KeyType));
    newKeyId = nanoid();
    newPublicKey = pair.publicKey;
    newPrivate = pair.privateKey;
    newBlob = publicKeyBlob(pair.publicKey);
    update({ newFingerprint: pair.fingerprint });

    enter('install');
    touched = true;
    const installed = await installKey(target, oldPrivate, oldBlob, newPublicKey, `bastionssh-key-${newKeyId}`, hop).catch(
      (err: unknown) => {
        if ((err instanceof RemoteStepError && err.unchanged) || failedBeforeRunning(err)) touched = false;
        throw err;
      },
    );
    logger.info({ rotationId, serverId, installed }, 'New SSH key installed for rotation');

    enter('verify');
    await verifyLogin(target, newPrivate, hop);

    enter('switch');
    const encryptedPrivateKey = await vault.encrypt(newPrivate, newKeyId);
    const oldKeyRow = oldKey;
    const now = new Date().toISOString();
    db.transaction((tx) => {
      tx.insert(sshKeys)
        .values({
          id: newKeyId!,
          orgId: initial.orgId,
          name: rotatedKeyName(server.name),
          type: options.type ?? oldKeyRow.type,
          publicKey: newPublicKey,
          fingerprint: pair.fingerprint,
          encryptedPrivateKey,
          keyVersion: 1,
          rotatedFromKeyId: oldKeyRow.id,
          createdBy: actor.userId,
        })
        .run();
      // Only if nobody reassigned the server meanwhile
      const moved = tx
        .update(servers)
        .set({ defaultKeyId: newKeyId!, updatedAt: now })
        .where(and(eq(servers.id, serverId), eq(servers.defaultKeyId, oldKeyRow.id), isNull(servers.encryptedPassword)))
        .run();
      if (moved.changes === 0) {
        throw new KeyRotationError('The server was assigned a different key during the rotation');
      }
    });
    switched = true;
    update({ newKeyId });
    // Pooled SFTP and Docker connections were opened with the old key
    evictServer(initial.orgId, serverId);
    evictDockerServer(initial.orgId, serverId);
    evictKubeServer(initial.orgId, serverId);

    enter('remove_old');
    const sharing = sharedAccountServers(server, oldKey.id);
    if (sharing.length > 0) {
      warnings.push(
        `The old key was left in authorized_keys: ${sharing.join(', ')} log in to the same account with it. Rotate them too, then remove it by hand.`,
      );
    } else {
      const removed = await removeKey(target, newPrivate, oldBlob, newBlob, hop);
      if (removed === 'absent') {
        warnings.push('The old key was not found in ~/.ssh/authorized_keys when it was due to be removed.');
      }
    }
  } catch (err) {
    const message = errorMessage(err);
    const failedStep = step;
    logger.warn({ err: message, rotationId, serverId, step: failedStep }, 'SSH key rotation failed');
    enter('rollback');

    let status: KeyRotationStatus;
    if (switched) {
      status = await rollBackAfterSwitch(target!, oldKey!, newKeyId!);
    } else {
      if (touched && target) {
        try {
          await removeKey(target, oldPrivate, newBlob, oldBlob, hop);
        } catch (rbErr) {
          warnings.push(
            `The new key line (tagged bastionssh-key-${newKeyId}) may still be in authorized_keys — removing it failed: ${errorMessage(rbErr)}. Its private key was discarded, so it grants no access; remove it by hand.`,
          );
        }
      }
      status = touched ? 'rolled_back' : 'failed';
    }
    const record = finish(status, { step: failedStep, error: message, ...(status !== 'completed' && { newKeyId: null }) });
    auditAs(actor, status === 'completed' ? 'ssh_key.rotate' : 'ssh_key.rotate_failed', 'server', serverId, serverName, {
      rotationId,
      batchId: initial.batchId,
      status,
      step: failedStep,
      error: message,
      oldKeyId: initial.oldKeyId,
      oldFingerprint: initial.oldFingerprint,
      ...(status === 'completed' && { newKeyId, newFingerprint: record.newFingerprint }),
      warnings,
    });
    return record;
  }

  /**
   * Something failed after the switch, normally removing the old key: the
   * server is on the new key and may or may not still list the old one. Go back to the old key only
   * if a fresh login with it works; otherwise stay on the new key, which was
   * verified. The old key is not retired either way.
   */
  async function rollBackAfterSwitch(
    target: SshTarget,
    old: typeof sshKeys.$inferSelect,
    newId: string,
  ): Promise<KeyRotationStatus> {
    try {
      await verifyLogin(target, oldPrivate, hop);
    } catch (err) {
      warnings.push(
        `Kept the new key: the old key no longer logs in (${errorMessage(err)}), so it was most likely removed. Check ~/.ssh/authorized_keys.`,
      );
      return 'completed';
    }
    let reverted = false;
    db.transaction((tx) => {
      const back = tx
        .update(servers)
        .set({ defaultKeyId: old.id, updatedAt: new Date().toISOString() })
        .where(and(eq(servers.id, serverId), eq(servers.defaultKeyId, newId)))
        .run();
      if (back.changes > 0) {
        tx.delete(sshKeys).where(eq(sshKeys.id, newId)).run();
        reverted = true;
      }
    });
    if (!reverted) {
      warnings.push('Kept the new key: the server was assigned another key during the rotation.');
      return 'completed';
    }
    evictServer(initial.orgId, serverId);
    evictDockerServer(initial.orgId, serverId);
    evictKubeServer(initial.orgId, serverId);
    try {
      await removeKey(target, oldPrivate, newBlob, oldBlob, hop);
    } catch (err) {
      warnings.push(
        `The new key line (tagged bastionssh-key-${newId}) could not be removed from authorized_keys: ${errorMessage(err)}. Its private key was deleted, so it grants no access; remove it by hand.`,
      );
    }
    return 'rolled_back';
  }

  enter('retire');
  let retired = false;
  try {
    retired = retireIfUnused(initial.orgId, oldKey!, actor, warnings);
  } catch (err) {
    warnings.push(`The old key could not be retired: ${errorMessage(err)}`);
  }

  const record = finish('completed', { step: 'done', oldKeyRetired: retired });
  auditAs(actor, 'ssh_key.rotate', 'server', serverId, serverName, {
    rotationId,
    batchId: initial.batchId,
    oldKeyId: initial.oldKeyId,
    oldFingerprint: initial.oldFingerprint,
    newKeyId,
    newFingerprint: record.newFingerprint,
    oldKeyRetired: retired,
    warnings,
  });
  return record;
}

/** Run queued rotations one after another (a bulk request), each to its end. */
export async function runRotations(ids: string[], actor: AuditActor, options: RotateOptions = {}): Promise<void> {
  for (const id of ids) {
    try {
      await runRotation(id, actor, options);
    } catch (err) {
      logger.error({ err, rotationId: id }, 'SSH key rotation could not run');
    }
  }
}
