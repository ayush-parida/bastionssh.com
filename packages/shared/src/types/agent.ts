/** Live state of an agent: connected now, known but not connected, or revoked for good. */
export type AgentStatus = 'online' | 'offline' | 'revoked';

/** An outbound connectivity agent, as admins see it. Never carries the token. */
export interface Agent {
  id: string;
  orgId: string;
  name: string;
  status: AgentStatus;
  /** Last time the agent connected, disconnected or answered a keepalive. */
  lastSeenAt: string | null;
  /** Version the agent reported when it last connected. */
  version: string | null;
  /** While online: when this connection was made, from where, and which local ports it allows. */
  connection: {
    connectedAt: string;
    remoteAddress: string;
    allowedPorts: number[];
    openStreams: number;
  } | null;
  /** Servers routed through this agent. */
  serverCount: number;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface CreateAgentRequest {
  name: string;
  /**
   * Local ports the agent will be told to allow (default: 22). Only written
   * into the install command — the agent's own config is what it enforces.
   */
  allowedPorts?: number[];
}

/** Creation is the only response that carries the token and the install command built from it. */
export interface CreatedAgent extends Agent {
  token: string;
  installCommand: string;
}
