import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { TRUNCATION_NOTICE, createCastWriter } from './recorder.js';

let dir: string;
let n = 0;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-recorder-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A writer on a fake clock: every event lands `step` ms after the previous one. */
function writer(opts: { maxBytes?: number; crlf?: boolean; step?: number } = {}) {
  let t = 1000;
  const file = path.join(dir, `r${++n}`, 'test.cast');
  const w = createCastWriter({
    file,
    header: { width: 80, height: 24, timestamp: 1_700_000_000, title: 'web-1' },
    maxBytes: opts.maxBytes ?? 1_000_000,
    crlf: opts.crlf,
    now: () => (t += opts.step ?? 250),
  });
  return { w, file };
}

/** Parse a cast the way a player would: a header object, then [time, code, data] tuples. */
function parseCast(text: string) {
  const lines = text.split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]!) as Record<string, unknown>;
  const events = lines.slice(1).map((l) => JSON.parse(l) as [number, string, string]);
  return { header, events };
}

describe('asciicast writer', () => {
  it('writes a valid asciicast v2 file and gzips it on finish', async () => {
    const { w, file } = writer();
    w.output(Buffer.from('$ ls\r\n'));
    w.input('l');
    w.resize(120, 40);
    w.marker('$ uptime');
    w.output(Buffer.from('done\r\n'));
    const result = await w.finish();

    expect(result.file).toBe(`${file}.gz`);
    expect(fs.existsSync(file)).toBe(false);
    const text = gunzipSync(fs.readFileSync(result.file)).toString('utf8');
    expect(Buffer.byteLength(text)).toBe(result.bytes);
    expect(result.truncated).toBe(false);

    const { header, events } = parseCast(text);
    expect(header).toEqual({ version: 2, width: 80, height: 24, timestamp: 1_700_000_000, title: 'web-1' });
    expect(events.map(([, code, data]) => [code, data])).toEqual([
      ['o', '$ ls\r\n'],
      ['i', 'l'],
      ['r', '120x40'],
      ['m', '$ uptime'],
      ['o', 'done\r\n'],
    ]);
    // Relative seconds, increasing
    const times = events.map(([time]) => time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBeCloseTo(0.25);
  });

  it('keeps a multi-byte character split across chunks intact', async () => {
    const { w } = writer();
    const bytes = Buffer.from('héllo ✓', 'utf8');
    w.output(bytes.subarray(0, 2)); // splits the é
    w.output(bytes.subarray(2, 9)); // splits the ✓
    w.output(bytes.subarray(9));
    const result = await w.finish();
    const { events } = parseCast(gunzipSync(fs.readFileSync(result.file)).toString('utf8'));
    expect(events.map(([, , data]) => data).join('')).toBe('héllo ✓');
    expect(events.every(([, , data]) => !data.includes('�'))).toBe(true);
  });

  it('turns bare newlines into CRLF for exec output', async () => {
    const { w } = writer({ crlf: true });
    w.output(Buffer.from('a\nb\r\nc\n'));
    const result = await w.finish();
    const { events } = parseCast(gunzipSync(fs.readFileSync(result.file)).toString('utf8'));
    expect(events[0]![2]).toBe('a\r\nb\r\nc\r\n');
  });

  it('stops at the size cap with a truncation marker', async () => {
    const maxBytes = 4096;
    const { w } = writer({ maxBytes });
    for (let i = 0; i < 200; i++) w.output(Buffer.from(`line ${i} ${'x'.repeat(40)}\r\n`));
    expect(w.truncated).toBe(true);
    // Nothing after the marker, however much more arrives
    const capped = w.bytes;
    w.output(Buffer.from('more'));
    expect(w.bytes).toBe(capped);
    const result = await w.finish();

    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(maxBytes);
    const text = gunzipSync(fs.readFileSync(result.file)).toString('utf8');
    expect(Buffer.byteLength(text)).toBe(result.bytes);
    const { events } = parseCast(text);
    expect(events.at(-2)?.slice(1)).toEqual(['m', 'truncated']);
    expect(events.at(-1)?.slice(1)).toEqual(['o', TRUNCATION_NOTICE]);
    expect(events.filter(([, code]) => code === 'm')).toHaveLength(1);
  });

  it('ignores events after finish and finishes only once', async () => {
    const { w } = writer();
    const first = w.finish();
    w.output(Buffer.from('late'));
    expect(await w.finish()).toEqual(await first);
    const { events } = parseCast(gunzipSync(fs.readFileSync((await first).file)).toString('utf8'));
    expect(events).toEqual([]);
  });

  it('deletes the file on discard', async () => {
    const { w, file } = writer();
    w.output(Buffer.from('x'));
    await w.discard();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.gz`)).toBe(false);
  });
});
