import { Duplex, PassThrough } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { dockerPermissions, type Role } from '@smt/shared';
import { getDb } from '../db/index.js';
import { memberships } from '../db/schema.js';
import logger from '../logger.js';
import { SSHBroker, type TerminalChannel } from '../ssh/broker.js';
import { compareApiVersions, type DockerClient } from './client.js';
import { Demuxer } from './demux.js';
import { DockerError } from './errors.js';
import { dockerSettings } from './settings.js';
import { apiPath } from './validation.js';

/**
 * A shell inside a container (D3), carried by the Engine API's exec: create
 * an exec, start it hijacked (`Upgrade: tcp`), and the raw stream is the
 * terminal. {@link openContainerShell} adapts that stream to the shape of an
 * SSH shell channel, so the terminal broker (ssh/broker.ts) runs it like any
 * other session — the same WebSocket, buffering, reaping, recording and
 * revocation. Resizes go to `/exec/:id/resize`.
 *
 * Everything travels over the caller's pooled SSH connection (docker/pool.ts):
 * the route holds that lease for as long as the shell is open.
 */

/** Tried in order when no command is given; the first that runs is the shell. */
export const DEFAULT_SHELLS = ['/bin/bash', '/bin/sh'] as const;

/** How long the check that a shell exists may take. */
const SHELL_CHECK_TIMEOUT_MS = 5_000;
/** After the terminal closes, how long to wait for the exec to report its exit code. */
const EXIT_CODE_WAIT_MS = 3_000;
/** API version that takes the initial terminal size with the exec (`ConsoleSize`). */
const CONSOLE_SIZE_API = '1.42';

/** `user`, `user:group`, `uid`, `uid:gid` — what `docker exec --user` takes. */
export const EXEC_USER_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63})?$/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ExecInspect {
  Running?: boolean;
  ExitCode?: number | null;
}

/** An exec's exit code once it has stopped; null if it is still running after `waitMs`. */
async function exitCodeOf(docker: DockerClient, execId: string, waitMs: number): Promise<number | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const info = await docker.json<ExecInspect>({ path: apiPath('exec', execId, 'json'), timeoutMs: waitMs });
    if (!info.Running && typeof info.ExitCode === 'number') return info.ExitCode;
    if (Date.now() >= deadline) return null;
    await sleep(50);
  }
}

/**
 * Whether `shell` runs in the container: `<shell> -c 'exit 0'`, started
 * detached, must exit 0. A missing binary exits 126/127 (or the daemon refuses
 * the start). A container that is not running or does not exist is an error,
 * not a missing shell.
 */
export async function shellWorks(docker: DockerClient, containerId: string, shell: string, user?: string): Promise<boolean> {
  // Creating the exec fails the same way for every shell (not running, gone): that is the answer
  const created = await docker.json<{ Id?: unknown }>({
    method: 'POST',
    path: apiPath('containers', containerId, 'exec'),
    body: { Cmd: [shell, '-c', 'exit 0'], AttachStdout: false, AttachStderr: false, ...(user && { User: user }) },
  });
  const execId = String(created.Id ?? '');
  if (!execId) return false;
  try {
    // Recent engines refuse the start itself (400 "stat /bin/bash: no such file") when the binary is missing
    await docker.text({ method: 'POST', path: apiPath('exec', execId, 'start'), body: { Detach: true, Tty: false } });
  } catch (err) {
    if (err instanceof DockerError && err.statusCode < 500 && err.statusCode !== 400) throw err;
    return false;
  }
  try {
    return (await exitCodeOf(docker, execId, SHELL_CHECK_TIMEOUT_MS)) === 0;
  } catch {
    return false;
  }
}

/** The shell to open: the first of {@link DEFAULT_SHELLS} that runs, else `/bin/sh` (its error then shows in the terminal). */
export async function pickShell(docker: DockerClient, containerId: string, user?: string): Promise<string[]> {
  for (const shell of DEFAULT_SHELLS) {
    if (await shellWorks(docker, containerId, shell, user)) return [shell];
  }
  return ['/bin/sh'];
}

export interface ContainerShellOptions {
  cmd: string[];
  user?: string;
  tty: boolean;
  cols: number;
  rows: number;
}

export interface ContainerShell {
  execId: string;
  /** The terminal, shaped like an SSH shell channel for the broker. */
  channel: TerminalChannel;
  /**
   * End the attach (idempotent) and resolve with the exit code once the exec
   * has stopped — null when it is still running or the daemon is gone.
   */
  close: () => Promise<number | null>;
}

/**
 * The hijacked exec stream as a {@link TerminalChannel}: output (demultiplexed
 * into stdout and stderr without a TTY) is readable, input is written to the
 * process, `setWindow` resizes the exec's TTY.
 */
export function execChannel(
  socket: Duplex,
  head: Buffer,
  tty: boolean,
  resize: (rows: number, cols: number) => void,
): TerminalChannel {
  const stderr = new PassThrough();
  const demuxer = tty ? null : new Demuxer();
  const channel = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk: Buffer, encoding, callback) {
      socket.write(chunk, encoding, callback);
    },
    final(callback) {
      socket.end();
      callback();
    },
    destroy(err, callback) {
      socket.destroy();
      stderr.end();
      callback(err);
    },
  }) as TerminalChannel;
  channel.stderr = stderr;
  channel.setWindow = (rows: number, cols: number) => {
    if (tty) resize(rows, cols);
  };

  const onData = (chunk: Buffer) => {
    if (!demuxer) {
      if (!channel.push(chunk)) socket.pause();
      return;
    }
    for (const frame of demuxer.push(chunk)) {
      if (frame.stream === 'stderr') stderr.write(frame.payload);
      else if (!channel.push(frame.payload)) socket.pause();
    }
  };
  if (head.length > 0) onData(head);
  socket.on('data', onData);
  socket.on('end', () => channel.push(null));
  // The process exited: the daemon ends its side but may keep the connection
  // half-open, so the session ends once the last output has been read
  channel.once('end', () => {
    if (!channel.destroyed) channel.destroy();
  });
  socket.on('error', (err: Error) => channel.destroy(err));
  // The process exited, or the connection under it went away
  socket.on('close', () => {
    if (!channel.destroyed) channel.destroy();
  });
  return channel;
}

/**
 * Create and attach an exec running `cmd` in the (running) container, sized
 * `cols`×`rows`. The returned channel is live; the caller registers it with
 * the broker and calls `close` when the session ends.
 */
export async function openContainerShell(
  docker: DockerClient,
  containerId: string,
  options: ContainerShellOptions,
): Promise<ContainerShell> {
  const { cmd, user, tty, cols, rows } = options;
  const consoleSize =
    tty && docker.apiVersion && compareApiVersions(docker.apiVersion, CONSOLE_SIZE_API) >= 0
      ? { ConsoleSize: [rows, cols] }
      : {};
  const created = await docker.json<{ Id?: unknown }>({
    method: 'POST',
    path: apiPath('containers', containerId, 'exec'),
    body: {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: tty,
      Cmd: cmd,
      ...(user && { User: user }),
      ...(tty && { Env: ['TERM=xterm-256color'] }),
      ...consoleSize,
    },
  });
  const execId = String(created.Id ?? '');
  if (!execId) throw new DockerError('Docker did not create the exec', 502);

  const { socket, head } = await docker.hijack({
    path: apiPath('exec', execId, 'start'),
    body: { Detach: false, Tty: tty, ...consoleSize },
  });

  // Resizes arrive with every window change; only the latest one matters
  let pending: { rows: number; cols: number } | null = null;
  let resizing = false;
  const resize = (r: number, c: number) => {
    pending = { rows: r, cols: c };
    if (resizing) return;
    resizing = true;
    void (async () => {
      while (pending) {
        const next: { rows: number; cols: number } = pending;
        pending = null;
        await docker
          .text({ method: 'POST', path: apiPath('exec', execId, 'resize'), query: { h: next.rows, w: next.cols } })
          .catch((err: unknown) => logger.debug({ err, execId }, 'Container exec resize failed'));
      }
      resizing = false;
    })();
  };
  const channel = execChannel(socket, head, tty, resize);
  // The size the exec was created with, for daemons that take no ConsoleSize
  if (tty) resize(rows, cols);

  let closing: Promise<number | null> | null = null;
  return {
    execId,
    channel,
    close() {
      closing ??= (async () => {
        // Dropping the attach alone leaves the process running in the
        // container (the daemon keeps its TTY open). So, as near as the API
        // gets to a terminal window closing: interrupt what runs in the
        // foreground, end the shell's input (^D at an empty prompt, or EOF
        // without a TTY), and give it a moment to exit.
        if (!channel.destroyed && socket.writable) {
          if (tty) socket.write('\x03\x04');
          socket.end();
        }
        try {
          return await exitCodeOf(docker, execId, EXIT_CODE_WAIT_MS);
        } catch {
          return null;
        } finally {
          if (!channel.destroyed) channel.destroy();
        }
      })();
      return closing;
    },
  };
}

/**
 * Close container shells whose owner may no longer open one — after a role
 * change, or an admin switching `operatorsCanExec` off. Scoped to one org;
 * `userId` narrows it to one member. Returns how many were closed.
 */
export function closeDisallowedExecSessions(orgId: string, userId?: string): number {
  const settings = dockerSettings(orgId);
  const allowed = new Map<string, boolean>();
  const mayExec = (user: string) => {
    let ok = allowed.get(user);
    if (ok === undefined) {
      const member = getDb()
        .select({ role: memberships.role, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.userId, user), eq(memberships.orgId, orgId)))
        .get();
      ok = !!member && member.status === 'active' && dockerPermissions(member.role as Role, settings).exec;
      allowed.set(user, ok);
    }
    return ok;
  };
  return SSHBroker.closeWhere(
    (s) => s.container !== null && s.orgId === orgId && (!userId || s.userId === userId) && !mayExec(s.userId),
  );
}
