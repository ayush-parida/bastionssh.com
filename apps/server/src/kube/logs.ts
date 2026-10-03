import type { IncomingMessage } from 'node:http';
import type { KubeLogEvent, KubeLogLine } from '@smt/shared';
import type { EventStream } from '../api/sse.js';
import { LineSplitter } from '../docker/demux.js';
import type { KubeObject } from './client.js';
import { KubeError } from './errors.js';

/**
 * Pod logs (K4, spec §4.2): read from `…/pods/:name/log` (client.ts `logs`)
 * and sent to the browser as server-sent events — operators and up, like
 * Docker's. Caps keep one log view from costing more than it shows:
 *
 * - history is at most {@link MAX_LOG_TAIL} lines, a download at most
 *   {@link MAX_DOWNLOAD_BYTES} (the API server's own `limitBytes`);
 * - a followed stream ends, saying so, after {@link MAX_STREAM_BYTES};
 * - lines are batched ({@link BATCH_MS}, {@link BATCH_LINES}) and a line
 *   longer than 64 KiB is split, so a chatty pod cannot flood the page;
 * - when the browser is not keeping up, the API stream is paused.
 *
 * Logs are what the container printed: they are not redacted (spec §8.4),
 * which is why they need the operator role.
 */

export const MAX_LOG_TAIL = 10_000;
export const DEFAULT_LOG_TAIL = 500;
export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const BATCH_MS = 100;
const BATCH_LINES = 1_000;

export const logLimits = { maxStreamBytes: MAX_STREAM_BYTES };

/** The annotation kubectl reads for the container to use when none is named. */
const DEFAULT_CONTAINER_ANNOTATION = 'kubectl.kubernetes.io/default-container';

interface ContainerSpec {
  name?: unknown;
}

function names(list: unknown): string[] {
  return Array.isArray(list) ? (list as ContainerSpec[]).map((c) => c?.name).filter((n): n is string => typeof n === 'string') : [];
}

/** Every container of a pod: init, app, then ephemeral. */
export function podContainerNames(pod: KubeObject): string[] {
  const spec = (pod.spec ?? {}) as { initContainers?: unknown; containers?: unknown; ephemeralContainers?: unknown };
  return [...names(spec.initContainers), ...names(spec.containers), ...names(spec.ephemeralContainers)];
}

/** The container logs and shells use when none is named: the annotated default, else the first app container. */
export function defaultContainer(pod: KubeObject): string | null {
  const spec = (pod.spec ?? {}) as { containers?: unknown };
  const app = names(spec.containers);
  const annotated = pod.metadata.annotations?.[DEFAULT_CONTAINER_ANNOTATION];
  if (annotated && podContainerNames(pod).includes(annotated)) return annotated;
  return app[0] ?? null;
}

/** `requested` if the pod has it, else the default container; 404 when there is none. */
export function resolveContainer(pod: KubeObject, requested?: string): string {
  if (requested) {
    if (!podContainerNames(pod).includes(requested)) throw new KubeError(`The pod has no container named ${requested}`, 404);
    return requested;
  }
  const picked = defaultContainer(pod);
  if (!picked) throw new KubeError('The pod has no containers', 404);
  return picked;
}

/** RFC 3339 times the kubelet puts in front of each line with `timestamps=true`. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}) /;

/** Raw log bytes → lines, the timestamp split off when there is one. */
export function logLineReader(timestamps: boolean) {
  const splitter = new LineSplitter();
  const toLine = (raw: string): KubeLogLine => {
    if (!timestamps) return { text: raw };
    const match = TIMESTAMP.exec(raw);
    return match ? { time: match[0].slice(0, -1), text: raw.slice(match[0].length) } : { text: raw };
  };
  return {
    push: (chunk: Buffer): KubeLogLine[] => splitter.push(chunk).map(toLine),
    flush: (): KubeLogLine[] => splitter.flush().map(toLine),
  };
}

/**
 * Read a log response into `sse` until it ends (`end`), the browser leaves,
 * or {@link logLimits} is reached (`end` with `truncated`). Resolves when done.
 */
export function pipeLogsToSse(res: IncomingMessage, sse: EventStream<KubeLogEvent>, timestamps: boolean): Promise<void> {
  const reader = logLineReader(timestamps);
  let batch: KubeLogLine[] = [];
  let timer: NodeJS.Timeout | undefined;
  let bytes = 0;

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (batch.length && !sse.closed) sse.send({ type: 'logs', lines: batch });
    batch = [];
  };

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sse.signal.removeEventListener('abort', stop);
      resolve();
    };
    const stop = () => {
      res.destroy();
      finish();
    };
    if (sse.signal.aborted) return stop();
    sse.signal.addEventListener('abort', stop, { once: true });

    res.on('data', (chunk: Buffer) => {
      if (sse.closed || finished) return;
      bytes += chunk.length;
      batch.push(...reader.push(chunk));
      if (bytes > logLimits.maxStreamBytes) {
        flush();
        sse.send({ type: 'end', truncated: true });
        return stop();
      }
      if (batch.length >= BATCH_LINES) flush();
      else timer ??= setTimeout(flush, BATCH_MS);
      if (sse.backpressured) {
        res.pause();
        sse.onDrain(() => res.resume());
      }
    });
    res.on('end', () => {
      if (!sse.closed && !finished) {
        batch.push(...reader.flush());
        flush();
        sse.send({ type: 'end' });
      }
      finish();
    });
    res.on('error', (err) => {
      if (!sse.closed && !finished) {
        flush();
        sse.fail(err);
      }
      finish();
    });
    res.on('close', () => {
      // Closed without an end: the connection under the stream went away
      if (!sse.closed && !finished) {
        flush();
        sse.fail(new KubeError('The connection to the Kubernetes API closed', 502));
      }
      finish();
    });
  });
}
