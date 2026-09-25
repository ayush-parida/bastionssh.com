import { SSHBroker } from '../ssh/broker.js';
import { evictUser } from '../ssh/sftp.js';
import { abortAgentStreams } from '../ai/streams.js';

/**
 * Ending browser sessions does not end what those sessions already opened.
 * This closes a user's live terminals (and their WebSockets), pooled SFTP
 * connections and in-flight AI agent streams, so a revocation takes effect
 * immediately rather than when those connections happen to close.
 */
export interface LiveAccessScope {
  /** Only what is open in this org; omit for every org (account-wide revocations). */
  orgId?: string;
  /**
   * Keep terminals and SFTP connections to these servers — used when access is
   * narrowed rather than removed. AI streams are always ended, since their
   * context may already describe servers the user can no longer see.
   */
  keepServerIds?: Iterable<string>;
}

export interface LiveAccessRevoked {
  terminals: number;
  sftp: number;
  agents: number;
}

export function revokeLiveAccess(userId: string, scope: LiveAccessScope = {}): LiveAccessRevoked {
  const keepServerIds = scope.keepServerIds ? [...scope.keepServerIds] : undefined;
  return {
    terminals: SSHBroker.closeForUser(userId, { orgId: scope.orgId, keepServerIds }),
    sftp: evictUser(userId, { orgId: scope.orgId, keepServerIds }),
    agents: abortAgentStreams(userId, { orgId: scope.orgId }),
  };
}
