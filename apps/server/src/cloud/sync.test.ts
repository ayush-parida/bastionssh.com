import { describe, it, expect } from 'vitest';
import type { CloudInstance } from '@smt/shared';
import { importTags, planSync, summarize } from './sync.js';

const inst = (over: Partial<CloudInstance>): CloudInstance => ({
  id: 'a',
  name: 'a',
  region: 'r1',
  state: 'running',
  publicIp: '1.1.1.1',
  privateIp: '10.0.0.1',
  tags: [],
  instanceType: null,
  ...over,
});

describe('planSync', () => {
  it('creates unknown instances when auto-import is on, and skips those without an ip', () => {
    const plan = planSync(
      [],
      [inst({ id: 'a' }), inst({ id: 'b', publicIp: null, privateIp: null })],
      true,
    );
    expect(plan.create.map((i) => i.id)).toEqual(['a']);
    expect(plan.skipped.map((i) => i.id)).toEqual(['b']);
    expect(plan.update).toEqual([]);
    expect(plan.markMissing).toEqual([]);
  });

  it('does not create when auto-import is off, but still updates and marks missing', () => {
    const plan = planSync(
      [
        { id: 's1', cloudInstanceId: 'a', host: '9.9.9.9', cloudState: 'running' },
        { id: 's2', cloudInstanceId: 'z', host: '8.8.8.8', cloudState: 'running' },
      ],
      [inst({ id: 'a', publicIp: '1.1.1.1' }), inst({ id: 'new' })],
      false,
    );
    expect(plan.create).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.update).toEqual([{ serverId: 's1', host: '1.1.1.1', region: 'r1', state: 'running' }]);
    expect(plan.markMissing).toEqual(['s2']);
  });

  it('prefers the public ip and keeps the old host when the instance has none', () => {
    const withPrivateOnly = planSync(
      [{ id: 's1', cloudInstanceId: 'a', host: '9.9.9.9', cloudState: 'running' }],
      [inst({ id: 'a', publicIp: null, privateIp: '10.0.0.7' })],
      true,
    );
    expect(withPrivateOnly.update[0]!.host).toBe('10.0.0.7');

    const withNone = planSync(
      [{ id: 's1', cloudInstanceId: 'a', host: '9.9.9.9', cloudState: 'running' }],
      [inst({ id: 'a', publicIp: null, privateIp: null, state: 'stopped' })],
      true,
    );
    expect(withNone.update[0]).toEqual({ serverId: 's1', host: null, region: 'r1', state: 'stopped' });
  });

  it('does not mark an already-missing server again, and revives it when it returns', () => {
    const stillGone = planSync(
      [{ id: 's1', cloudInstanceId: 'gone', host: 'x', cloudState: 'missing' }],
      [],
      true,
    );
    expect(stillGone.markMissing).toEqual([]);

    const back = planSync(
      [{ id: 's1', cloudInstanceId: 'gone', host: 'x', cloudState: 'missing' }],
      [inst({ id: 'gone' })],
      true,
    );
    expect(back.update).toEqual([{ serverId: 's1', host: '1.1.1.1', region: 'r1', state: 'running' }]);
  });
});

describe('importTags', () => {
  it('puts provider and region first and deduplicates', () => {
    expect(importTags('aws', inst({ region: 'us-east-1', tags: ['Env:prod', 'us-east-1'] }))).toEqual([
      'cloud:aws',
      'us-east-1',
      'Env:prod',
    ]);
  });
});

describe('summarize', () => {
  it('counts each part of the plan', () => {
    expect(
      summarize({ create: [inst({})], update: [], markMissing: ['s'], skipped: [inst({})] }, 3),
    ).toEqual({ discovered: 3, created: 1, updated: 0, missing: 1, skipped: 1 });
  });
});
