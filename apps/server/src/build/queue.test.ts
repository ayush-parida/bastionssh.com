import { describe, expect, it } from 'vitest';
import { BuildQueue } from './queue.js';

/** One build at a time: the rest wait in order, told their place; a cancelled one leaves the line. */

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const job = (app: string) => ({ app, serverId: 's1' });

describe('the build queue', () => {
  it('runs one build at a time, in arrival order, telling the waiting ones their place', async () => {
    const queue = new BuildQueue(10);
    const order: string[] = [];
    const places: Record<string, number[]> = { b: [], c: [] };
    const gate = { a: deferred(), b: deferred(), c: deferred() };
    const run = (name: 'a' | 'b' | 'c') =>
      queue.run(
        job(name),
        new AbortController().signal,
        async () => {
          order.push(`start ${name}`);
          await gate[name].promise;
          order.push(`end ${name}`);
          return name;
        },
        (p) => places[name]?.push(p),
      );
    const a = run('a');
    const b = run('b');
    const c = run('c');
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['start a']);
    expect(queue.status()).toMatchObject({ running: { app: 'a', serverId: 's1' }, queued: 2 });
    expect(places).toEqual({ b: [1], c: [2] });
    gate.a.resolve();
    expect(await a).toBe('a');
    await new Promise((r) => setTimeout(r, 5));
    // c moved up when b started
    expect(places.c).toEqual([2, 1]);
    expect(order).toEqual(['start a', 'end a', 'start b']);
    gate.c.resolve();
    gate.b.resolve();
    expect(await Promise.all([b, c])).toEqual(['b', 'c']);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(queue.status()).toEqual({ running: null, queued: 0 });
  });

  it('lets the next build go when one fails', async () => {
    const queue = new BuildQueue(10);
    const failing = queue.run(job('a'), new AbortController().signal, async () => {
      throw new Error('boom');
    });
    const next = queue.run(job('b'), new AbortController().signal, async () => 'b ran');
    await expect(failing).rejects.toThrow('boom');
    expect(await next).toBe('b ran');
  });

  it('drops a waiting build that is cancelled, without running it, and moves the others up', async () => {
    const queue = new BuildQueue(10);
    const gate = deferred();
    const first = queue.run(job('a'), new AbortController().signal, () => gate.promise);
    const cancel = new AbortController();
    let ran = false;
    const waiting = queue.run(job('b'), cancel.signal, async () => {
      ran = true;
    });
    const places: number[] = [];
    const third = queue.run(job('c'), new AbortController().signal, async () => 'c', (p) => places.push(p));
    await new Promise((r) => setTimeout(r, 5));
    cancel.abort(new Error('cancelled by ann'));
    await expect(waiting).rejects.toThrow('cancelled by ann');
    expect(places).toEqual([2, 1]);
    expect(queue.status().queued).toBe(1);
    gate.resolve();
    await first;
    expect(await third).toBe('c');
    expect(ran).toBe(false);
  });

  it('refuses a build already cancelled, and one beyond the waiting limit', async () => {
    const queue = new BuildQueue(1);
    const cancelled = new AbortController();
    cancelled.abort(new Error('too late'));
    await expect(queue.run(job('x'), cancelled.signal, async () => 1)).rejects.toThrow('too late');
    const gate = deferred();
    const a = queue.run(job('a'), new AbortController().signal, () => gate.promise);
    const b = queue.run(job('b'), new AbortController().signal, async () => 'b');
    await expect(queue.run(job('c'), new AbortController().signal, async () => 'c')).rejects.toMatchObject({ statusCode: 503, code: 'builder_busy' });
    gate.resolve();
    await a;
    expect(await b).toBe('b');
  });
});
