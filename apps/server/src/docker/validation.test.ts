import { describe, it, expect } from 'vitest';
import { DockerError } from './errors.js';
import { shellCommand, shellQuote } from './shell.js';
import {
  apiPath,
  containerRef,
  imageRef,
  isValidImageReference,
  isValidSocketPath,
  objectName,
  parseImageReference,
} from './validation.js';

describe('container references', () => {
  it('accepts names and ids', () => {
    for (const ok of ['web', 'my_app.1-2', 'a'.repeat(64), 'abc123', 'A'.repeat(255)]) expect(containerRef(ok)).toBe(ok);
  });

  it('refuses anything that could reshape an API path', () => {
    for (const bad of ['', '../images', 'a/b', '-rm', '.hidden', 'a b', 'a?x=1', 'a%2f', 'A'.repeat(256), 'x\n']) {
      expect(() => containerRef(bad)).toThrow(DockerError);
    }
    expect(() => containerRef(42)).toThrow('Invalid container name or id');
  });

  it('answers 400', () => {
    try {
      containerRef('../x');
    } catch (err) {
      expect((err as DockerError).statusCode).toBe(400);
    }
  });

  it('checks volume and network names the same way', () => {
    expect(objectName('data_1')).toBe('data_1');
    expect(() => objectName('../etc', 'volume name')).toThrow('Invalid volume name');
  });
});

describe('image references', () => {
  it('parses the Docker reference grammar', () => {
    expect(parseImageReference('nginx')).toEqual({ domain: null, path: 'nginx', tag: null, digest: null });
    expect(parseImageReference('ghcr.io/org/app:1.2.3')).toEqual({ domain: 'ghcr.io', path: 'org/app', tag: '1.2.3', digest: null });
    expect(parseImageReference('localhost:5000/team/app')).toMatchObject({ domain: 'localhost:5000', path: 'team/app' });
    expect(parseImageReference(`app@sha256:${'a'.repeat(64)}`)).toMatchObject({ path: 'app', digest: `sha256:${'a'.repeat(64)}` });
    expect(parseImageReference(`library/redis:7-alpine@sha256:${'b'.repeat(64)}`)).toMatchObject({ tag: '7-alpine' });
  });

  it('refuses what the grammar refuses', () => {
    for (const bad of ['', 'Upper', 'nginx/UPPER', 'app:', ':tag', 'a//b', 'app:-x', 'app@sha256:zz', 'app b', '../x', 'a;rm -rf /', `x:${'t'.repeat(129)}`]) {
      expect(isValidImageReference(bad)).toBe(false);
    }
    expect(isValidImageReference(`${'a'.repeat(256)}`)).toBe(false);
  });

  it('accepts ids as well as references', () => {
    expect(imageRef(`sha256:${'c'.repeat(64)}`)).toBe(`sha256:${'c'.repeat(64)}`);
    expect(imageRef('0123456789ab')).toBe('0123456789ab');
    expect(() => imageRef('sha256:../../x')).toThrow(DockerError);
  });
});

describe('socket paths', () => {
  it('takes plain absolute paths only', () => {
    expect(isValidSocketPath('/var/run/docker.sock')).toBe(true);
    expect(isValidSocketPath('/run/user/1000/podman/podman.sock')).toBe(true);
    for (const bad of ['docker.sock', '/var/run/../../etc/shadow', '/tmp/a b', "/tmp/a'b", '/tmp/$(id)', '/tmp/a\nb', '/']) {
      expect(isValidSocketPath(bad)).toBe(false);
    }
  });
});

describe('API paths and shell quoting', () => {
  it('encodes every dynamic path segment', () => {
    expect(apiPath('containers', 'a b/../c', 'json')).toBe('/containers/a%20b%2F..%2Fc/json');
  });

  it('single-quotes arguments so the remote shell interprets nothing', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellCommand(['docker', '--host', 'unix:///run/x.sock; rm -rf /', '$(id)', '`id`'])).toBe(
      `'docker' '--host' 'unix:///run/x.sock; rm -rf /' '$(id)' '\`id\`'`,
    );
    expect(() => shellQuote('a\0b')).toThrow();
  });
});
