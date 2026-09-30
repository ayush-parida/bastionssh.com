import type { ServerCloudInfo } from './cloud.js';
import type { HostKeyStatus } from './host-key.js';
import type { DockerMode, ServerDocker } from './docker.js';

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
  /** Managed server this one is reached through (like `ssh -J`); null for a direct connection. */
  jumpServerId: string | null;
  /** Reached through this connectivity agent instead of directly; null = direct. */
  agentId: string | null;
  /** Docker on this server: whether it is on, and what the last probe found. */
  docker: ServerDocker;
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
  /** Reach this server through another server in the org; null or omitted connects directly. */
  jumpServerId?: string | null;
  /** Connect through this agent (to its loopback, on `port`); null or absent = directly to `host`. */
  agentId?: string | null;
  dockerMode?: DockerMode;
  dockerSocketPath?: string | null;
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
  /** null removes the jump host. */
  jumpServerId?: string | null;
  agentId?: string | null;
  /** Admin only: `off` hides Docker for this server. */
  dockerMode?: DockerMode;
  /** Admin only: Docker socket override; null returns to detection. Clears the cached probe. */
  dockerSocketPath?: string | null;
}

export interface ServerGroup {
  id: string;
  orgId: string;
  name: string;
  serverIds: string[];
  createdAt: string;
  updatedAt: string;
}
