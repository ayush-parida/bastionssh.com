import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { Demuxer, LineSplitter, demuxBuffer, demuxStream, type DemuxedChunk } from './demux.js';
import { frame } from './fake-daemon.test-helper.js';

describe('Docker stream demultiplexing', () => {
  it('splits stdout and stderr frames', () => {
    const frames = demuxBuffer(Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n'), frame(1, '')]));
    expect(frames.map((f) => [f.stream, f.payload.toString()])).toEqual([
      ['stdout', 'out\n'],
      ['stderr', 'err\n'],
      ['stdout', ''],
    ]);
  });

  it('holds a frame split across reads, even inside its header', () => {
    const bytes = Buffer.concat([frame(1, 'hello'), frame(2, 'world')]);
    const demuxer = new Demuxer();
    const out: DemuxedChunk[] = [];
    for (let i = 0; i < bytes.length; i += 3) out.push(...demuxer.push(bytes.subarray(i, i + 3)));
    expect(out.map((f) => `${f.stream}:${f.payload}`)).toEqual(['stdout:hello', 'stderr:world']);
    expect(demuxer.pending).toBe(0);
  });

  it('keeps an unfinished frame pending rather than emitting half of it', () => {
    const demuxer = new Demuxer();
    const whole = frame(1, 'abcdef');
    expect(demuxer.push(whole.subarray(0, 10))).toEqual([]);
    expect(demuxer.pending).toBe(10);
    expect(demuxer.push(whole.subarray(10)).map((f) => f.payload.toString())).toEqual(['abcdef']);
  });

  it('passes unframed bytes through instead of buffering for a length read from text', () => {
    const demuxer = new Demuxer();
    const out = [...demuxer.push(Buffer.from('hello world\n')), ...demuxer.push(Buffer.from('more\n'))];
    expect(out.map((f) => `${f.stream}:${f.payload}`)).toEqual(['stdout:hello world\n', 'stdout:more\n']);
    expect(demuxer.pending).toBe(0);
  });

  it('works as an object-mode transform', async () => {
    const source = Readable.from([Buffer.concat([frame(2, 'a'), frame(1, 'b')])]);
    const chunks: DemuxedChunk[] = [];
    for await (const chunk of source.pipe(demuxStream())) chunks.push(chunk as DemuxedChunk);
    expect(chunks.map((c) => c.stream)).toEqual(['stderr', 'stdout']);
  });
});

describe('LineSplitter', () => {
  it('holds a partial line until it completes, and strips CR', () => {
    const s = new LineSplitter();
    expect(s.push(Buffer.from('one\r\ntw'))).toEqual(['one']);
    expect(s.push(Buffer.from('o\nthree'))).toEqual(['two']);
    expect(s.flush()).toEqual(['three']);
    expect(s.flush()).toEqual([]);
  });

  it('does not mangle a multi-byte character split across chunks', () => {
    const s = new LineSplitter();
    const bytes = Buffer.from('héllo\n');
    expect([...s.push(bytes.subarray(0, 2)), ...s.push(bytes.subarray(2))]).toEqual(['héllo']);
  });

  it('cuts runaway lines so the buffer stays bounded', () => {
    const s = new LineSplitter(4);
    expect(s.push(Buffer.from('abcdefghij'))).toEqual(['abcd', 'efgh']);
    expect(s.flush()).toEqual(['ij']);
  });
});
