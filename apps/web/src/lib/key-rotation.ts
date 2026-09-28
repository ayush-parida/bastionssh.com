import type { BulkRotateKeysResponse, KeyRotation, KeyType, SSHKey } from '@smt/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { withStepUp } from '@/lib/passkeys.js';

/** Keys older than this are flagged for rotation. */
export const KEY_AGE_WARNING_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since the key was created (a rotated key counts from its rotation). */
export function keyAgeDays(key: Pick<SSHKey, 'createdAt'>): number {
  return Math.floor((Date.now() - new Date(key.createdAt).getTime()) / DAY_MS);
}

/** Old enough that it should be rotated; retired keys are never flagged. */
export function isKeyOld(key: Pick<SSHKey, 'createdAt' | 'retiredAt'>): boolean {
  return !key.retiredAt && keyAgeDays(key) > KEY_AGE_WARNING_DAYS;
}

/** Rotate one server's key; resolves once the rotation has finished, whatever its outcome. */
export function rotateServerKey(serverId: string, type?: KeyType): Promise<KeyRotation> {
  return withStepUp(() => api.post<KeyRotation>(`/servers/${serverId}/rotate-key`, type ? { type } : {}));
}

/** Queue rotations of several servers; they run one after another on the server. */
export function rotateServerKeys(serverIds: string[], type?: KeyType): Promise<BulkRotateKeysResponse> {
  return withStepUp(() => api.post<BulkRotateKeysResponse>('/keys/rotate', { serverIds, ...(type && { type }) }));
}

/** Tell the user how a finished rotation went. */
export function toastRotation(r: KeyRotation) {
  const detail = [r.error, ...r.warnings].filter(Boolean).join(' ');
  if (r.status === 'completed') {
    if (r.warnings.length) toast.warning(`Key rotated on ${r.serverName}, with warnings: ${detail}`, { duration: 15_000 });
    else toast.success(`Key rotated on ${r.serverName}${r.oldKeyRetired ? '; the old key is retired' : ''}`);
  } else if (r.status === 'rolled_back') {
    toast.error(`Rotation on ${r.serverName} failed and was rolled back — it still uses its old key. ${detail}`, {
      duration: 15_000,
    });
  } else {
    toast.error(`Rotation on ${r.serverName} failed; nothing was changed. ${detail}`, { duration: 15_000 });
  }
}

export const ROTATION_CONFIRM =
  'A new key is generated and added to ~/.ssh/authorized_keys over the current key. Once a login with it works, ' +
  'the server switches to it and the old key line is removed. If anything fails, the change is rolled back.';
