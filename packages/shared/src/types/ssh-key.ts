export type KeyType = 'rsa' | 'ed25519' | 'ecdsa';

export interface SSHKey {
  id: string;
  orgId: string;
  name: string;
  type: KeyType;
  publicKey: string;
  fingerprint: string;
  keyVersion: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Set once a rotation moved the last server off this key; it can no longer be assigned. */
  retiredAt: string | null;
  /** The key this one replaced, when a rotation created it. */
  rotatedFromKeyId: string | null;
  /** private key is never sent to the client */
}

export interface CreateSSHKeyRequest {
  name: string;
  /** Provide either privateKey (import) or generate: true (create new) */
  privateKey?: string;
  generate?: boolean;
  type?: KeyType;
}

export interface GenerateSSHKeyResponse {
  key: SSHKey;
  /** One-time: private key returned only at creation, not stored in plaintext */
  privateKeyPem: string;
}

/**
 * - `pending`: queued in a bulk rotation;
 * - `running`: in progress;
 * - `completed`: the server uses the new key (see `warnings` for anything left to check);
 * - `rolled_back`: something failed after the server was changed; it was put back on the old key;
 * - `failed`: something failed before the server was changed; nothing to undo;
 * - `interrupted`: the app restarted mid-rotation — check the server's authorized_keys.
 */
export type KeyRotationStatus = 'pending' | 'running' | 'completed' | 'rolled_back' | 'failed' | 'interrupted';

/** Steps of a rotation, in order; `step` on a record is the last one reached. */
export type KeyRotationStep =
  | 'prepare'
  | 'install'
  | 'verify'
  | 'switch'
  | 'remove_old'
  | 'retire'
  | 'rollback'
  | 'done';

export interface KeyRotation {
  id: string;
  batchId: string | null;
  /** Null once the server has been deleted. */
  serverId: string | null;
  serverName: string;
  oldKeyId: string;
  oldFingerprint: string;
  newKeyId: string | null;
  newFingerprint: string | null;
  status: KeyRotationStatus;
  step: KeyRotationStep | null;
  error: string | null;
  warnings: string[];
  oldKeyRetired: boolean;
  startedBy: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface RotateKeyRequest {
  /** Type of the new key; defaults to the type of the key being replaced. */
  type?: KeyType;
}

export interface BulkRotateKeysRequest extends RotateKeyRequest {
  serverIds: string[];
}

export interface BulkRotateKeysResponse {
  batchId: string;
  /** One pending rotation per server, run one after another in the background. */
  rotations: KeyRotation[];
}
