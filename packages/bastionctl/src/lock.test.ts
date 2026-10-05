import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DockerApi } from './docker.js';
import { startFakeDocker, type FakeDocker } from './fake-docker.test-helper.js';
import { acquireLock, readLock, STALE_AFTER_MS } from './lock.js';

let dir: string;
let file: string;
let fake: FakeDocker;
let docker: DockerApi;

beforeAll(async () => {
  fake = await startFakeDocker();
  docker = new DockerApi(fake.socket);
});
afterAll(() => fake.close());
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-lock-'));
  file = path.join(dir, 'deploy.lock');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const held = (info: object) => fs.writeFileSync(file, JSON.stringify(info));

describe('deploy locks', () => {
  it('is exclusive, says who holds it, and releases only its own file', async () => {
    const release = await acquireLock(file, { holder: 'ann@example.com', docker, what: 'deploy of site1' });
    expect(readLock(file)).toMatchObject({ holder: 'ann@example.com', host: os.hostname(), pid: process.pid });
    await expect(acquireLock(file, { holder: 'bob', docker, what: 'deploy of site1' })).rejects.toMatchObject({
      exitCode: 4,
      message: expect.stringMatching(/deploy of site1 is locked by ann@example.com since/),
    });
    // Someone took it over meanwhile (stale): our release leaves theirs alone
    held({ holder: 'carol', host: 'elsewhere', pid: 1, since: new Date().toISOString() });
    release();
    expect(readLock(file)?.holder).toBe('carol');
  });

  it('takes over a lock older than 30 minutes', async () => {
    held({ holder: 'old', host: 'abcdef123456', pid: 1, since: new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString() });
    const release = await acquireLock(file, { holder: 'new', docker, what: 'x' });
    expect(readLock(file)?.holder).toBe('new');
    release();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('takes over a lock whose bastionctl container is gone, but not one still running', async () => {
    // Every bastionctl run is a container: its hostname is the container's short id
    held({ holder: 'gone', host: 'abcdef123456', pid: 7, since: new Date().toISOString() });
    await expect(acquireLock(file, { holder: 'new', docker, what: 'x' })).resolves.toBeTypeOf('function');
    fs.rmSync(file);

    fake.images.set('node', { Id: 'sha256:1', Labels: {} });
    const res = await docker.json<{ Id: string }>('POST', '/containers/create', { query: { name: 'runner' }, body: { Image: 'node' } });
    await docker.start('runner');
    held({ holder: 'busy', host: res.Id.slice(0, 12), pid: 7, since: new Date().toISOString() });
    await expect(acquireLock(file, { holder: 'new', docker, what: 'x' })).rejects.toThrow(/locked by busy/);
  });

  it('checks the pid for a holder on this same host', async () => {
    held({ holder: 'dead', host: os.hostname(), pid: 2 ** 22 + 12345, since: new Date().toISOString() });
    await expect(acquireLock(file, { holder: 'new', what: 'x' })).resolves.toBeTypeOf('function');
    fs.rmSync(file);
    held({ holder: 'alive', host: os.hostname(), pid: process.pid, since: new Date().toISOString() });
    await expect(acquireLock(file, { holder: 'new', what: 'x' })).rejects.toThrow(/locked by alive/);
    // An unreadable lock (half written by a run that died) is stale
    fs.writeFileSync(file, '{"holder":');
    await expect(acquireLock(file, { holder: 'new', what: 'x' })).resolves.toBeTypeOf('function');
  });
});
