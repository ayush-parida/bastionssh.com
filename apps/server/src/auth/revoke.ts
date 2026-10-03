import { SSHBroker } from '../ssh/broker.js';
import { evictUser } from '../ssh/sftp.js';
import { abortAgentStreams } from '../ai/streams.js';
import { closeDockerForUser } from '../docker/index.js';
import { closeKubeForUser } from '../kube/index.js';

/**
 * Ending browser sessions does not end what those sessions already opened.
 * This closes a user's live terminals (and their WebSockets), pooled SFTP
 * and Docker connections, Docker and Kubernetes event streams and in-flight
 * AI agent streams, so a revocation takes effect immediately rather than
 * when those connections happen to close.
 */
export interface LiveAccessScope {
  /** Only what is open in this org; omit for every org (account-wide revocations). */
  orgId?: string;
  /**
   * Keep terminals, SFTP and Docker connections to these servers — used when
   * access is narrowed rather than removed. AI streams are always ended, since their
   * context may already describe servers the user can no longer see.
   */
  keepServerIds?: Iterable<string>;
  /**
   * Keep Kubernetes streams on these clusters. Narrowing server access keeps
   * the clusters the member still has (and the other way round); omitted
   * together with `keepServerIds`, everything closes.
   */
  keepClusterIds?: Iterable<string>;
}

export interface LiveAccessRevoked {
  terminals: number;
  sftp: number;
  /** Docker connections and streams. */
  docker: number;
  /** Kubernetes streams and per-user caches. */
  kube: number;
  agents: number;
}

export function revokeLiveAccess(userId: string, scope: LiveAccessScope = {}): LiveAccessRevoked {
  const keepServerIds = scope.keepServerIds ? [...scope.keepServerIds] : undefined;
  const keepClusterIds = scope.keepClusterIds ? [...scope.keepClusterIds] : undefined;
  return {
    terminals: SSHBroker.closeForUser(userId, { orgId: scope.orgId, keepServerIds }),
    sftp: evictUser(userId, { orgId: scope.orgId, keepServerIds }),
    docker: closeDockerForUser(userId, { orgId: scope.orgId, keepServerIds }),
    kube: closeKubeForUser(userId, { orgId: scope.orgId, keepClusterIds }),
    agents: abortAgentStreams(userId, { orgId: scope.orgId }),
  };
}
