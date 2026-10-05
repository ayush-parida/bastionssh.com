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
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
