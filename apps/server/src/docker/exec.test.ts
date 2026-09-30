import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EXEC_USER_PATTERN, execChannel, pickShell, shellWorks } from './exec.js';
import { DockerError } from './errors.js';
import type { DockerClient } from './client.js';
import { frame } from './fake-daemon.test-helper.js';

/**
 * A stand-in for the hijacked socket: what the daemon sends is `push`ed into
 * it, what the channel writes is collected.
 */
function socketPair() {
  const fromClient: Buffer[] = [];
  const duplex = new PassThrough();
  duplex.write = ((chunk: Buffer, _enc?: unknown, cb?: () => void) => {
    fromClient.push(Buffer.from(chunk));
    cb?.();
    return true;
  }) as typeof duplex.write;
  return { duplex, fromClient };
}

function collect(stream: NodeJS.ReadableStream) {
  const out = { text: '' };
  stream.on('data', (d: Buffer) => (out.text += d.toString()));
  return out;
}

describe('execChannel', () => {
  it('passes a TTY stream through, with the bytes that came with the upgrade first', async () => {
    const { duplex, fromClient } = socketPair();
    const resize = vi.fn();
    const channel = execChannel(duplex, Buffer.from('hello '), true, resize);
    const out = collect(channel);
    duplex.push('world');
    await new Promise((r) => setImmediate(r));
    expect(out.text).toBe('hello world');
    channel.write('ls\r');
    expect(Buffer.concat(fromClient).toString()).toBe('ls\r');
    channel.setWindow(40, 120, 0, 0);
    expect(resize).toHaveBeenCalledWith(40, 120);
  });

  it('splits a multiplexed stream into stdout and stderr without a TTY, and never resizes', async () => {
    const { duplex } = socketPair();
    const resize = vi.fn();
    const channel = execChannel(duplex, Buffer.alloc(0), false, resize);
    const out = collect(channel);
    const err = collect(channel.stderr);
    const bytes = Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n')]);
    duplex.push(bytes.subarray(0, 3));
    duplex.push(bytes.subarray(3));
    await new Promise((r) => setImmediate(r));
    expect(out.text).toBe('out\n');
    expect(err.text).toBe('err\n');
    channel.setWindow(40, 120, 0, 0);
    expect(resize).not.toHaveBeenCalled();
  });

  it('closes when the daemon ends the stream, and destroys the stream when closed', async () => {
    const { duplex } = socketPair();
    const channel = execChannel(duplex, Buffer.alloc(0), true, () => {});
    const closed = new Promise((r) => channel.once('close', r));
    channel.resume();
    duplex.destroy();
    await closed;

    const other = socketPair();
    const second = execChannel(other.duplex, Buffer.alloc(0), true, () => {});
    second.destroy();
    await new Promise((r) => setImmediate(r));
    expect(other.duplex.destroyed).toBe(true);
  });
});

/** A client whose exec answers `exitCodes[shell]` for the shell check. */
function fakeClient(exitCodes: Record<string, number | 'refuse'>, createError?: DockerError) {
  const execs: string[] = [];
  const docker = {
    json: vi.fn(async (req: { method?: string; path: string; body?: { Cmd?: string[] } }) => {
      if (req.path.endsWith('/exec') && req.method === 'POST') {
        if (createError) throw createError;
        execs.push(req.body!.Cmd![0]!);
        return { Id: `x${execs.length}` };
      }
      const shell = execs[Number(req.path.match(/x(\d+)/)![1]) - 1]!;
      return { Running: false, ExitCode: exitCodes[shell] };
    }),
    text: vi.fn(async (req: { path: string }) => {
      const shell = execs[Number(req.path.match(/x(\d+)/)![1]) - 1]!;
      if (exitCodes[shell] === 'refuse') throw new DockerError('OCI runtime exec failed', 502);
      return '';
    }),
  };
  return { docker: docker as unknown as DockerClient, execs };
}

describe('pickShell', () => {
  it('prefers bash, then sh', async () => {
    expect(await pickShell(fakeClient({ '/bin/bash': 0, '/bin/sh': 0 }).docker, 'c')).toEqual(['/bin/bash']);
    expect(await pickShell(fakeClient({ '/bin/bash': 127, '/bin/sh': 0 }).docker, 'c')).toEqual(['/bin/sh']);
    expect(await pickShell(fakeClient({ '/bin/bash': 'refuse', '/bin/sh': 0 }).docker, 'c')).toEqual(['/bin/sh']);
    // Nothing runs: /bin/sh anyway, and its error shows in the terminal
    expect(await pickShell(fakeClient({ '/bin/bash': 126, '/bin/sh': 126 }).docker, 'c')).toEqual(['/bin/sh']);
  });

  it('passes on a container that is not running rather than guessing', async () => {
    const { docker } = fakeClient({}, new DockerError('Container c is not running', 409));
    await expect(shellWorks(docker, 'c', '/bin/bash')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('EXEC_USER_PATTERN', () => {
  it('takes what docker exec --user takes', () => {
    for (const ok of ['root', '0', '1000:1000', 'www-data', 'www-data:www-data', 'app.user']) expect(EXEC_USER_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ['', 'root;id', 'a b', ':1000', 'root:', '-u', '$(id)', 'a'.repeat(70)]) expect(EXEC_USER_PATTERN.test(bad), bad).toBe(false);
  });
});
