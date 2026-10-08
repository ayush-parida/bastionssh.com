import { DeployError } from '../deploy/errors.js';

/**
 * One build at a time on the BastionSSH side (bastion-side builds spec §2):
 * the builder's CPU and memory go to one build, and a deploy that arrives
 * meanwhile waits its turn, told its place in the line. A waiting build that
 * is cancelled (or whose request is gone) leaves the line without running.
 * Kept in memory: a restart of BastionSSH ends every build anyway.
 */

export interface BuildJob {
  app: string;
  serverId: string;
}

interface Waiting {
  job: BuildJob;
  start: () => void;
  notify?: (position: number) => void;
}

export class BuildQueue {
  private current: { job: BuildJob; since: Date } | null = null;
  private waiting: Waiting[] = [];

  constructor(private readonly maxWaiting: number) {}

  /** The build running now, and how many wait. */
  status(): { running: { app: string; serverId: string; since: string } | null; queued: number } {
    return {
      running: this.current ? { app: this.current.job.app, serverId: this.current.job.serverId, since: this.current.since.toISOString() } : null,
      queued: this.waiting.length,
    };
  }

  /**
   * Run `fn` when it is `job`'s turn. `onQueued` hears the place in the line
   * (1 = next) while it waits, again whenever it moves up. Aborting `signal`
   * while waiting rejects with its reason and leaves the line.
   */
  async run<T>(job: BuildJob, signal: AbortSignal, fn: () => Promise<T>, onQueued?: (position: number) => void): Promise<T> {
    signal.throwIfAborted();
    if (this.current) {
      if (this.waiting.length >= this.maxWaiting) {
        throw new DeployError(`${this.waiting.length} builds are waiting already; try again when they are done`, 503, 'builder_busy');
      }
      await new Promise<void>((resolve, reject) => {
        const entry: Waiting = { job, start: resolve, notify: onQueued };
        const onAbort = () => {
          const i = this.waiting.indexOf(entry);
          if (i !== -1) {
            this.waiting.splice(i, 1);
            this.announce();
          }
          reject(signal.reason);
        };
        entry.start = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        this.waiting.push(entry);
        onQueued?.(this.waiting.length);
      });
      // The build before handed its place over (current is this job already)
    } else {
      this.current = { job, since: new Date() };
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      // Handed over before anyone else can see the builder free
      this.current = next ? { job: next.job, since: new Date() } : null;
      this.announce();
      next?.start();
    }
  }

  /** Tell each waiting build its place after the line moved. */
  private announce() {
    this.waiting.forEach((w, i) => w.notify?.(i + 1));
  }
}
