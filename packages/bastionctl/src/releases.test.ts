import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv, quote, setEnv, unsetEnv } from './env.js';
import { containerName, Layout, newReleaseId, NAME_PATTERN, volumeName } from './names.js';
import { currentRelease, previousRelease, pruneCandidates, releaseIds, setCurrent } from './releases.js';

describe('release ids', () => {
  it('are the UTC second and the start of the source checksum', () => {
    const id = newReleaseId(new Date('2026-10-05T09:08:07.654Z'), 'ABCDEF0123456789');
    expect(id).toBe('20261005-090807-abcdef01');
    expect(NAME_PATTERN.test(id)).toBe(true);
    // Sortable by time
    expect(newReleaseId(new Date('2026-10-05T10:00:00Z'), 'ff'.repeat(16)) > id).toBe(true);
  });
});

describe('Docker names', () => {
  it('never give two apps the same volume', () => {
    // App a's volume b-data and app a-b's volume data were one volume, and purging a deleted a-b's data
    expect(volumeName('a', 'b-data')).not.toBe(volumeName('a-b', 'data'));
    expect(volumeName('site1', 'uploads')).toBe('bastion-site1.uploads');
    expect(containerName('site1', '20261005-090807-abcdef01')).toBe('bastion-site1-20261005-090807-abcdef01');
  });
});

describe('pruning', () => {
  const ids = ['r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07'];

  it('keeps the newest keep_releases', () => {
    expect(pruneCandidates(ids, 5, 'r07', 'r06')).toEqual(['r02', 'r01']);
    expect(pruneCandidates(ids, 7, 'r07', 'r06')).toEqual([]);
  });

  it('never removes the current or previous release, however old (after a rollback)', () => {
    expect(pruneCandidates(ids, 2, 'r01', 'r07')).toEqual(['r05', 'r04', 'r03', 'r02']);
    expect(pruneCandidates(ids, 2, 'r02', 'r01')).toEqual(['r05', 'r04', 'r03']);
  });
});

describe('current and previous', () => {
  let root: string;
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('moves current atomically and remembers what it pointed at', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-releases-'));
    const layout = new Layout(root);
    for (const id of ['r2', 'r1']) fs.mkdirSync(layout.release('a', id), { recursive: true });
    fs.mkdirSync(path.join(layout.releases('a'), 'Not-A-Release'));
    expect(releaseIds(layout, 'a')).toEqual(['r1', 'r2']);
    expect(currentRelease(layout, 'a')).toBeNull();

    setCurrent(layout, 'a', 'r1');
    expect(currentRelease(layout, 'a')).toBe('r1');
    expect(previousRelease(layout, 'a')).toBeNull();
    // A relative link, so the folder can move
    expect(fs.readlinkSync(layout.current('a'))).toBe('releases/r1');

    setCurrent(layout, 'a', 'r2');
    expect([currentRelease(layout, 'a'), previousRelease(layout, 'a')]).toEqual(['r2', 'r1']);
    setCurrent(layout, 'a', 'r1');
    expect([currentRelease(layout, 'a'), previousRelease(layout, 'a')]).toEqual(['r1', 'r2']);

    // A hand-made link outside releases/ is not taken for a release
    fs.rmSync(layout.current('a'));
    fs.symlinkSync('/etc', layout.current('a'));
    expect(currentRelease(layout, 'a')).toBeNull();
  });
});

describe('.env files', () => {
  it('round-trips any value, keeps comments and order', () => {
    const text = '# secrets\nA=1\nexport B = two words # note\nC="quoted \\"x\\"\\nnext"\nD=\'lit $x\'\n';
    expect([...parseEnv(text)]).toEqual([
      ['A', '1'],
      ['B', 'two words'],
      ['C', 'quoted "x"\nnext'],
      ['D', 'lit $x'],
    ]);
    const tricky = 'line1\nline2 "q" \\ $HOME `x` \t end';
    const next = setEnv(text, 'B', tricky);
    expect(parseEnv(next).get('B')).toBe(tricky);
    expect(next.split('\n')[0]).toBe('# secrets');
    expect(next).toContain(`B=${quote(tricky)}`);
    expect(parseEnv(setEnv('', 'NEW', 'v'))).toEqual(new Map([['NEW', 'v']]));
    expect(unsetEnv(next, 'A')).not.toContain('A=');
    expect(unsetEnv(next, 'MISSING')).toBeNull();
    expect(unsetEnv('A=1\n', 'A')).toBe('');
  });

  it('refuses bad names and oversized values', () => {
    expect(() => setEnv('', '1BAD', 'x')).toThrow(/Invalid variable name/);
    expect(() => setEnv('', 'A-B', 'x')).toThrow(/Invalid variable name/);
    expect(() => setEnv('', 'A', 'x'.repeat(65 * 1024))).toThrow(/larger/);
  });
});
