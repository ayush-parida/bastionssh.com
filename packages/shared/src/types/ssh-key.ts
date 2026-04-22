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
