import type { ServerCloudInfo } from './cloud.js';
import type { HostKeyStatus } from './host-key.js';

export interface Server {
  id: string;
  orgId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'key' | 'password';
  defaultKeyId?: string;
  tags: string[];
  notes?: string;
  /** Present when the server came from a cloud account sync. */
  cloud: ServerCloudInfo | null;
  /** Pinned SSH host key, `SHA256:<base64>` as `ssh-keygen -lf` prints it; null until first connect. */
  hostKeyFingerprint: string | null;
  hostKeyStatus: HostKeyStatus;
  /** Reached through this connectivity agent instead of directly; null = direct. */
  agentId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateServerRequest {
  name: string;
  host: string;
  port?: number;
  username: string;
  authType?: 'key' | 'password';
  defaultKeyId?: string;
  password?: string;
  tags?: string[];
  notes?: string;
  /** Pre-pin the host key instead of trusting whatever answers on first connect. */
  hostKeyFingerprint?: string;
  /** Connect through this agent (to its loopback, on `port`); null or absent = directly to `host`. */
  agentId?: string | null;
}

export interface UpdateServerRequest {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  authType?: 'key' | 'password';
  defaultKeyId?: string;
  password?: string;
  tags?: string[];
  notes?: string;
  hostKeyFingerprint?: string;
  agentId?: string | null;
}

export interface ServerGroup {
  id: string;
  orgId: string;
  name: string;
  serverIds: string[];
  createdAt: string;
  updatedAt: string;
}
