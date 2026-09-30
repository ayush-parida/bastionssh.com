import type { FastifyRequest } from 'fastify';
import type { DockerContainer } from '@smt/shared';
import { Demuxer, LineSplitter } from './demux.js';
import { DockerError } from './errors.js';
import { toContainer } from './objects.js';
import { redactInspect } from './redact.js';
import { withDockerClient } from './service.js';
import { apiPath, containerRef } from './validation.js';

/**
 * What the AI assistant's read-only Docker tools return (ai/tools.ts): plain
 * text for the model, through `withDockerClient` like every Docker route, so
 * per-server access, Docker off and detection apply. Inspect output is always
 * the redacted form; logs are capped like `run_command` output. Nothing here
 * changes a container — the assistant proposes those through `run_command`,
 * which asks the user first.
 */

type Requester = Pick<FastifyRequest, 'orgId' | 'user'>;

/** Most log lines the assistant may ask for. */
export const AI_MAX_LOG_TAIL = 500;
export const AI_DEFAULT_LOG_TAIL = 100;
/** Output cap, the same as `run_command`'s stdout. */
export const AI_MAX_OUTPUT = 64_000;
/** Bytes read from the daemon for one logs call; the rest is not fetched. */
const MAX_LOG_READ = 4 * 1024 * 1024;
const LOGS_TIMEOUT_MS = 20_000;
export const TRUNCATED_MARKER = '[output truncated]';

/** `since` as the daemon wants it (unix seconds), from unix seconds or a date. */
export function aiSince(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return text;
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new DockerError('"since" must be unix seconds or a date', 400);
  return String(Math.floor(t / 1000));
}

/** Lines to fetch: an integer between 1 and {@link AI_MAX_LOG_TAIL}, default {@link AI_DEFAULT_LOG_TAIL}. */
export function aiTail(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return AI_DEFAULT_LOG_TAIL;
  return Math.min(AI_MAX_LOG_TAIL, Math.max(1, Math.floor(n)));
}

/** One line per container, the facts a person would look at first. */
export function formatContainers(containers: DockerContainer[], all: boolean): string {
  if (containers.length === 0) return all ? 'No containers.' : 'No running containers.';
  return containers
    .map((c) => {
      const ports = c.ports.map((p) => (p.publicPort ? `${p.publicPort}->${p.privatePort}/${p.type}` : `${p.privatePort}/${p.type}`));
      const parts = [
        `- ${c.name} (${c.id.slice(0, 12)})`,
        `image ${c.image}`,
        `state ${c.state}${c.health ? `, ${c.health}` : ''}`,
        c.status,
        ports.length ? `ports ${[...new Set(ports)].join(', ')}` : null,
        c.composeProject ? `compose ${c.composeProject}${c.composeService ? `/${c.composeService}` : ''}` : null,
      ];
      return parts.filter(Boolean).join(' · ');
    })
    .join('\n');
}

/** Keep the end of `text` (the newest log lines) within `limit` characters. */
export function keepTail(text: string, limit = AI_MAX_OUTPUT): string {
  if (text.length <= limit) return text;
  const cut = text.slice(text.length - limit);
  const newline = cut.indexOf('\n');
  return `${TRUNCATED_MARKER}\n${newline === -1 ? cut : cut.slice(newline + 1)}`;
}

/** Keep the start of `text` within `limit` characters. */
export function keepHead(text: string, limit = AI_MAX_OUTPUT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n${TRUNCATED_MARKER}`;
}

export async function aiListContainers(req: Requester, serverId: string, all: boolean): Promise<string> {
  return withDockerClient(req, serverId, async (ctx) => {
    const raw = await ctx.docker.json<Record<string, unknown>[]>({ path: '/containers/json', query: { all } });
    return formatContainers(raw.map(toContainer), all);
  });
}

/** A container's inspect payload, environment values redacted, as indented JSON (capped). */
export async function aiInspect(req: Requester, serverId: string, container: unknown): Promise<string> {
  const ref = containerRef(container);
  return withDockerClient(req, serverId, async (ctx) => {
    const raw = await ctx.docker.json<Record<string, unknown>>({ path: apiPath('containers', ref, 'json') });
    return keepHead(JSON.stringify(redactInspect(raw), null, 2));
  });
}

/**
 * The last `tail` lines of a container's logs (stdout and stderr, stderr
 * lines marked), newest kept when the output is over the cap.
 */
export async function aiContainerLogs(
  req: Requester,
  serverId: string,
  container: unknown,
  opts: { tail?: unknown; since?: unknown } = {},
): Promise<string> {
  const ref = containerRef(container);
  const tail = aiTail(opts.tail);
  const since = aiSince(opts.since);
  return withDockerClient(req, serverId, async (ctx) => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), LOGS_TIMEOUT_MS);
    try {
      const info = await ctx.docker.json<{ Config?: { Tty?: unknown } }>({
        path: apiPath('containers', ref, 'json'),
        signal: deadline.signal,
      });
      const tty = info.Config?.Tty === true;
      const res = await ctx.docker.stream({
        path: apiPath('containers', ref, 'logs'),
        query: { stdout: true, stderr: true, follow: false, tail, since },
        signal: deadline.signal,
      });
      const demuxer = new Demuxer();
      const out = { stdout: new LineSplitter(), stderr: new LineSplitter() };
      const lines: string[] = [];
      const take = (stream: 'stdout' | 'stderr', text: string[]) => {
        for (const l of text) lines.push(stream === 'stderr' ? `[stderr] ${l}` : l);
      };
      let read = 0;
      let cut = false;
      await new Promise<void>((resolve, reject) => {
        res.on('data', (chunk: Buffer) => {
          read += chunk.length;
          if (tty) take('stdout', out.stdout.push(chunk));
          else {
            for (const frame of demuxer.push(chunk)) {
              const stream = frame.stream === 'stderr' ? 'stderr' : 'stdout';
              take(stream, out[stream].push(frame.payload));
            }
          }
          if (read > MAX_LOG_READ) {
            cut = true;
            res.destroy();
            resolve();
          }
        });
        res.on('end', resolve);
        res.on('close', resolve);
        res.on('error', (err) => (cut ? resolve() : reject(err)));
      });
      if (deadline.signal.aborted && !cut) throw new DockerError('Docker did not send the logs in time', 504);
      take('stdout', out.stdout.flush());
      take('stderr', out.stderr.flush());
      if (lines.length === 0) return since ? 'No log lines in that period.' : 'No log output.';
      const text = keepTail(lines.join('\n'));
      return cut && !text.startsWith(TRUNCATED_MARKER) ? `${TRUNCATED_MARKER}\n${text}` : text;
    } finally {
      clearTimeout(timer);
    }
  });
}
