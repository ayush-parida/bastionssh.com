import type { DeployProxyUpgrade } from '@smt/shared';
import type { DockerApi } from './docker.js';
import type { Layout } from './names.js';

/** What every command works with; tests build one around a fake Docker API and a temp root. */
export interface Ctx {
  layout: Layout;
  docker: DockerApi;
  /** Progress for people: stderr, streamed to BastionSSH's deploy log. */
  log: (line: string) => void;
  /** Who runs this: passed in by BastionSSH (BASTION_ACTOR), else the SSH user. */
  actor: string;
  now: () => Date;
  /** How long the old container keeps serving after the proxy switched (spec §5 step 7). */
  drainMs: number;
  /** Pause between health check attempts. */
  healthIntervalMs: number;
  /** Cap on an upload's unpacked size. */
  maxSourceBytes?: number;
  /** How long a replaced proxy container may take to accept connections (default 30s). */
  proxyReadyMs?: number;
  /**
   * What the command did besides its own result, for `--json` to add to it
   * (or to `{ error }`): a proxy upgrade it ran first (BastionSSH audits it).
   */
  report?: { proxyUpgrade?: DeployProxyUpgrade };
  /** The Docker socket's path on the host (the wrapper passes it): what bastion-cron mounts. */
  hostSocket?: string;
  /** Where the nginx helper's state is mounted (default /var/lib/bastion-nginx; tests use a temp folder). */
  nginxStateDir?: string;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
