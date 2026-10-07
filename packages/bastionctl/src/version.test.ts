import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASTIONCTL_VERSION } from './version.js';

describe('version', () => {
  it('is the package version when run from source (the build adds +<build>)', () => {
    const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(BASTIONCTL_VERSION).toBe(version);
  });
});
