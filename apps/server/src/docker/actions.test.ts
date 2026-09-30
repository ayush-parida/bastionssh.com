import { describe, it, expect } from 'vitest';
import {
  SIGNAL_PATTERN,
  pruneIncludesNamedVolumes,
  pullTarget,
  toImageRemoveResult,
  toPrunePreview,
  toPruneResult,
  toPullProgress,
} from './actions.js';

describe('pullTarget', () => {
  it('splits a reference the way /images/create wants it, defaulting to latest', () => {
    expect(pullTarget('nginx')).toEqual({ fromImage: 'nginx', tag: 'latest', reference: 'nginx:latest' });
    expect(pullTarget('nginx', '1.27')).toEqual({ fromImage: 'nginx', tag: '1.27', reference: 'nginx:1.27' });
    expect(pullTarget('ghcr.io/acme/app:2.0')).toEqual({ fromImage: 'ghcr.io/acme/app', tag: '2.0', reference: 'ghcr.io/acme/app:2.0' });
    expect(pullTarget('localhost:5000/app')).toMatchObject({ fromImage: 'localhost:5000/app', tag: 'latest' });
    const digest = 'sha256:' + 'e'.repeat(64);
    expect(pullTarget(`app@${digest}`)).toEqual({ fromImage: 'app', tag: digest, reference: `app@${digest}` });
  });

  it('refuses what is not a reference, and a tag given twice', () => {
    for (const bad of ['', 'UPPER', 'a b', 'nginx;id', '$(id)', 'nginx:', '-nginx', 'a'.repeat(300)]) {
      expect(() => pullTarget(bad), bad).toThrow(/Invalid image reference/);
    }
    expect(() => pullTarget('nginx:1', '2')).toThrow(/not both/);
    expect(() => pullTarget('nginx', 'bad tag')).toThrow(/Invalid tag/);
    expect(() => pullTarget('nginx', '-x')).toThrow(/Invalid tag/);
  });
});

describe('toPullProgress', () => {
  it('reads progress lines and errors', () => {
    expect(toPullProgress({ status: 'Downloading', id: 'abc', progressDetail: { current: 5, total: 10 } })).toEqual({
      id: 'abc',
      status: 'Downloading',
      current: 5,
      total: 10,
    });
    expect(toPullProgress({ status: 'Pulling from library/nginx' })).toEqual({
      id: null,
      status: 'Pulling from library/nginx',
      current: null,
      total: null,
    });
    expect(toPullProgress({ error: 'boom', errorDetail: { message: 'boom' } })).toEqual({ error: 'boom' });
    expect(toPullProgress({ errorDetail: { message: 'only detail' } })).toEqual({ error: 'only detail' });
  });
});

describe('SIGNAL_PATTERN', () => {
  it('takes signal names and numbers only', () => {
    for (const ok of ['SIGTERM', 'TERM', 'SIGKILL', 'HUP', '9', '15', 'SIGRTMIN+3']) expect(SIGNAL_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ['', 'sigterm', 'SIG TERM', '100', 'TERM;id', '$(id)']) expect(SIGNAL_PATTERN.test(bad), bad).toBe(false);
  });
});

describe('prune', () => {
  const df = {
    Containers: [
      { State: 'running', SizeRw: 5 },
      { State: 'exited', SizeRw: 10 },
      { State: 'created', SizeRw: 1 },
      { State: 'paused', SizeRw: 100 },
    ],
    Images: [
      { RepoTags: ['nginx:1'], Containers: 1, Size: 500, SharedSize: 0 },
      { RepoTags: ['old:1'], Containers: 0, Size: 300, SharedSize: 100 },
      { RepoTags: ['<none>:<none>'], Containers: 0, Size: 50, SharedSize: -1 },
    ],
    Volumes: [
      { Name: 'db-data', Labels: {}, UsageData: { RefCount: 0, Size: 1000 } },
      { Name: 'f'.repeat(64), Labels: null, UsageData: { RefCount: 0, Size: 20 } },
      { Name: 'anon', Labels: { 'com.docker.volume.anonymous': '' }, UsageData: { RefCount: 0, Size: 30 } },
      { Name: 'e'.repeat(64), UsageData: { RefCount: 1, Size: 999 } },
    ],
  };
  const networks = [{ Name: 'bridge' }, { Name: 'host' }, { Name: 'none' }, { Name: 'shop_default' }, { Name: 'idle' }, { Name: 'ingress', Scope: 'swarm' }];
  const inUse = new Map([['shop_default', 2], ['bridge', 1]]);

  it('estimates each kind, keeping named volumes on Docker 23+', () => {
    expect(toPrunePreview(df, networks, inUse, '1.47')).toEqual({
      containers: { count: 2, size: 11 },
      danglingImages: { count: 1, size: 50 },
      unusedImages: { count: 2, size: 250 },
      volumes: { count: 2, size: 50 },
      volumesIncludeNamed: false,
      networks: { count: 1, size: null },
    });
  });

  it('counts named volumes on older engines, which prune them too', () => {
    expect(pruneIncludesNamedVolumes('1.41')).toBe(true);
    expect(pruneIncludesNamedVolumes('1.42')).toBe(false);
    expect(toPrunePreview(df, networks, inUse, '1.41').volumes).toEqual({ count: 3, size: 1050 });
  });

  it('adds up what was reclaimed', () => {
    expect(
      toPruneResult({
        containers: { ContainersDeleted: ['a'], SpaceReclaimed: 10 },
        images: { ImagesDeleted: null, SpaceReclaimed: 0 },
        networks: { NetworksDeleted: ['n'] },
      }),
    ).toEqual({
      containers: { deleted: 1, reclaimed: 10 },
      images: { deleted: 0, reclaimed: 0 },
      volumes: null,
      networks: { deleted: 1 },
      reclaimed: 10,
    });
  });
});

describe('toImageRemoveResult', () => {
  it('splits untagged and deleted', () => {
    expect(toImageRemoveResult([{ Untagged: 'a:1' }, { Deleted: 'sha256:1' }, { Deleted: 'sha256:2' }])).toEqual({
      untagged: ['a:1'],
      deleted: ['sha256:1', 'sha256:2'],
    });
    expect(toImageRemoveResult(null)).toEqual({ untagged: [], deleted: [] });
  });
});
