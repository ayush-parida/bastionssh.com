import { SSHBroker } from '../ssh/broker.js';
import { evictUser } from '../ssh/sftp.js';
import { abortAgentStreams } from '../ai/streams.js';
import { closeDockerForUser } from '../docker/index.js';
import { abortDeployStreams } from '../deploy/sse.js';
import { closeKubeForUser } from '../kube/index.js';
import { evictFtpUser } from '../ftp/index.js';
import { abortStorageFolderDownloads } from '../storage/folder.js';

/**
 * Ending browser sessions does not end what those sessions already opened.
 * This closes a user's live terminals (and their WebSockets), pooled SFTP,
 * FTP and Docker connections, Docker, Kubernetes and deploy log streams and
 * in-flight AI agent streams, so a revocation takes effect immediately rather
 * than when those connections happen to close. Object Storage folder
 * downloads end too. Cloud accounts, saved commands and cron jobs hold
 * nothing open per user, so they have no keep set: their next request is
 * simply refused.
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
   * Keep Kubernetes streams and pod shells on these clusters. Narrowing server access keeps
   * the clusters the member still has (and the other way round); omitted
   * together with `keepServerIds`, everything closes.
   */
  keepClusterIds?: Iterable<string>;
  /**
   * Of the kept servers and clusters, those where terminals, SFTP and pod
   * shells may stay open — the member may still operate there. A resource
   * that stays visible at `view` keeps its Docker and Kubernetes streams but
   * not its shells. Omitted: the keep sets above apply to shells as well.
   */
  keepShellServerIds?: Iterable<string>;
  keepShellClusterIds?: Iterable<string>;
  /**
   * Keep pooled FTP/SFTP-connection sessions on these connections. Omitted,
   * they are kept when another keep set narrows access (servers and clusters
   * say nothing about connections) and closed when everything is revoked.
   */
  keepFtpConnectionIds?: Iterable<string>;
  /**
   * Keep Object Storage folder downloads on these connections (the only
   * storage request that outlives a click). Omitted, like FTP: kept when
   * another keep set narrows access, ended when everything is revoked.
   */
  keepStorageConnectionIds?: Iterable<string>;
}

export interface LiveAccessRevoked {
  terminals: number;
  sftp: number;
  /** Docker connections and streams, deploy log streams included (they share the connection). */
  docker: number;
  /** Kubernetes streams and per-user caches. */
  kube: number;
  agents: number;
  /** Pooled FTP/SFTP-connection sessions. */
  ftp?: number;
  /** Object Storage folder downloads. */
  storage?: number;
}

export function revokeLiveAccess(userId: string, scope: LiveAccessScope = {}): LiveAccessRevoked {
  const keepServerIds = scope.keepServerIds ? [...scope.keepServerIds] : undefined;
  const keepClusterIds = scope.keepClusterIds ? [...scope.keepClusterIds] : undefined;
  const shellServerIds = scope.keepShellServerIds ? [...scope.keepShellServerIds] : keepServerIds;
  const shellClusterIds = scope.keepShellClusterIds ? [...scope.keepShellClusterIds] : keepClusterIds;
  const narrowing = !!(keepServerIds || keepClusterIds);
  const ftp =
    scope.keepFtpConnectionIds || !narrowing
      ? evictFtpUser(userId, { orgId: scope.orgId, keepConnectionIds: scope.keepFtpConnectionIds })
      : 0;
  const storage =
    scope.keepStorageConnectionIds || !narrowing
      ? abortStorageFolderDownloads(userId, { orgId: scope.orgId, keepConnectionIds: scope.keepStorageConnectionIds })
      : 0;
  return {
    terminals: SSHBroker.closeForUser(userId, {
      orgId: scope.orgId,
      keepServerIds: shellServerIds,
      keepClusterIds: shellClusterIds,
    }),
    sftp: evictUser(userId, { orgId: scope.orgId, keepServerIds: shellServerIds }),
    docker: closeDockerForUser(userId, { orgId: scope.orgId, keepServerIds }) + abortDeployStreams(userId, { orgId: scope.orgId, keepServerIds }),
    kube: closeKubeForUser(userId, { orgId: scope.orgId, keepClusterIds }),
    agents: abortAgentStreams(userId, { orgId: scope.orgId }),
    ...(ftp && { ftp }),
    ...(storage && { storage }),
  };
}
