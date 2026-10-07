import { describe, expect, it } from 'vitest';
import type { DockerComposeProject } from '@smt/shared';
import {
  archiveFileName,
  buildCommands,
  isArchiveName,
  manageableProjects,
  matchingServices,
  normalizeImageRef,
  recallUpload,
  rememberUpload,
} from './docker-upload.js';

describe('image references', () => {
  it('compares references the way Docker resolves them', () => {
    expect(normalizeImageRef('knexbi-website')).toBe('knexbi-website:latest');
    expect(normalizeImageRef('knexbi-website:latest')).toBe('knexbi-website:latest');
    expect(normalizeImageRef('docker.io/library/nginx:1.27')).toBe('nginx:1.27');
    expect(normalizeImageRef('library/nginx')).toBe('nginx:latest');
    expect(normalizeImageRef('docker.io/acme/app')).toBe('acme/app:latest');
    expect(normalizeImageRef('localhost:5000/app')).toBe('localhost:5000/app:latest');
    expect(normalizeImageRef('ghcr.io/org/app@sha256:abc')).toBe('ghcr.io/org/app@sha256:abc');
  });

  it('names the saved file after the image', () => {
    expect(archiveFileName('knexbi-website:latest')).toBe('knexbi-website.tar.gz');
    expect(archiveFileName('knexbi-website')).toBe('knexbi-website.tar.gz');
    expect(archiveFileName('ghcr.io/org/app:1.2')).toBe('app-1.2.tar.gz');
    expect(archiveFileName('  ')).toBe('image.tar.gz');
  });

  it('accepts what docker save writes, plain or compressed', () => {
    for (const name of ['a.tar', 'a.tar.gz', 'a.tgz', 'a.TAR.GZ', 'a.tar.xz', 'a.tar.zst', 'a.tar.bz2']) expect(isArchiveName(name), name).toBe(true);
    for (const name of ['a.zip', 'a.gz', 'Dockerfile', 'a.tar.gz.part']) expect(isArchiveName(name), name).toBe(false);
  });
});

describe('build instructions', () => {
  it('builds for the server’s platform and saves with gzip', () => {
    expect(buildCommands({ image: 'knexbi-website:latest', context: 'knexbi.com/', platform: 'linux/amd64' })).toEqual({
      build: 'docker build --platform linux/amd64 -t knexbi-website:latest knexbi.com/',
      save: 'docker save knexbi-website:latest | gzip > knexbi-website.tar.gz',
    });
    expect(buildCommands({ image: '', context: '', platform: 'linux/arm64' }).build).toBe('docker build --platform linux/arm64 -t my-app:latest .');
  });
});

describe('which service an upload is for', () => {
  const services = [
    { project: 'infra', service: 'website', image: 'knexbi-website:latest' },
    { project: 'infra', service: 'db', image: 'postgres:16' },
    { project: 'blog', service: 'web', image: 'docker.io/library/knexbi-website' },
    { project: 'blog', service: 'cache', image: null },
  ];

  it('matches the configured image against the loaded tags', () => {
    expect(matchingServices(['knexbi-website:latest'], services).map((s) => `${s.project}/${s.service}`)).toEqual(['infra/website', 'blog/web']);
    expect(matchingServices(['other:1'], services)).toEqual([]);
  });

  it('offers only projects actions can run on', () => {
    const project = (name: string, unmanageable: string | null, services = 1) =>
      ({ name, unmanageable, services: Array.from({ length: services }, (_, i) => ({ name: `s${i}`, containers: [], running: 0 })) }) as unknown as DockerComposeProject;
    expect(manageableProjects([project('a', null), project('b', 'no working dir'), project('c', null, 0)]).map((p) => p.name)).toEqual(['a']);
  });
});

describe('what the dialog remembers', () => {
  const memoryStorage = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
  };

  it('keeps the image, project and service per server', () => {
    const storage = memoryStorage();
    rememberUpload('s1', { image: 'app:1', context: '.' }, storage);
    rememberUpload('s1', { project: 'infra', service: 'website' }, storage);
    expect(recallUpload('s1', storage)).toEqual({ image: 'app:1', context: '.', project: 'infra', service: 'website' });
    expect(recallUpload('s2', storage)).toEqual({});
  });

  it('survives storage that is missing, throws, or holds junk', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(recallUpload('s1', throwing)).toEqual({});
    expect(() => rememberUpload('s1', { image: 'x' }, throwing)).not.toThrow();
    expect(recallUpload('s1', null)).toEqual({});
    const junk = memoryStorage();
    junk.setItem('docker-upload:s1', '{"image": 42, "project": "infra"');
    expect(recallUpload('s1', junk)).toEqual({});
    junk.setItem('docker-upload:s1', '{"image": 42, "project": "infra"}');
    expect(recallUpload('s1', junk)).toEqual({ project: 'infra' });
  });
});
