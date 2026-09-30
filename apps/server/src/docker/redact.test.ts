import { describe, it, expect } from 'vitest';
import { REDACTED, redactEnv, redactInspect } from './redact.js';

describe('environment redaction', () => {
  it('hides every value and keeps the names', () => {
    expect(redactEnv(['DB_PASSWORD=hunter2', 'EMPTY=', 'URL=postgres://u:p@h/db?x=1', 'INHERITED'])).toEqual([
      `DB_PASSWORD=${REDACTED}`,
      `EMPTY=${REDACTED}`,
      `URL=${REDACTED}`,
      'INHERITED',
    ]);
  });

  it('leaves a missing or odd Env alone', () => {
    expect(redactEnv(null)).toBeNull();
    expect(redactEnv(undefined)).toBeUndefined();
    expect(redactEnv([42])).toEqual([REDACTED]);
  });

  it('redacts container and image inspect payloads without touching the input', () => {
    const container = {
      Id: 'abc',
      Config: { Env: ['TOKEN=secret'], Labels: { 'app.secret-looking': 'shown as is' } },
      HostConfig: { Binds: ['/a:/b'] },
    };
    const out = redactInspect(container);
    expect(out.Config.Env).toEqual([`TOKEN=${REDACTED}`]);
    expect(out.Config.Labels).toEqual({ 'app.secret-looking': 'shown as is' });
    expect(out.HostConfig).toBe(container.HostConfig);
    expect(container.Config.Env).toEqual(['TOKEN=secret']);

    const image = { Config: { Env: ['A=1'] }, ContainerConfig: { Env: ['B=2'] } };
    expect(redactInspect(image)).toEqual({ Config: { Env: [`A=${REDACTED}`] }, ContainerConfig: { Env: [`B=${REDACTED}`] } });
  });

  it('never leaks a value anywhere in the redacted JSON', () => {
    const out = JSON.stringify(redactInspect({ Config: { Env: ['S3_SECRET=zzz-very-secret'] } }));
    expect(out).not.toContain('zzz-very-secret');
  });
});
