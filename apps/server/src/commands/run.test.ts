import { describe, it, expect } from 'vitest';
import { extractVariables, interpolate } from './run.js';

describe('interpolate', () => {
  it('replaces every occurrence of a placeholder', () => {
    expect(interpolate('systemctl restart {{svc}} && systemctl status {{svc}}', { svc: 'nginx' })).toBe(
      'systemctl restart nginx && systemctl status nginx',
    );
  });

  it('leaves unknown placeholders alone rather than blanking them', () => {
    expect(interpolate('tail -n {{lines}} {{file}}', { lines: '50' })).toBe('tail -n 50 {{file}}');
  });

  it('is a no-op with no variables', () => {
    expect(interpolate('uptime')).toBe('uptime');
  });
});

describe('extractVariables', () => {
  it('finds placeholders in order of first use, without duplicates', () => {
    expect(extractVariables('cp {{src}} {{dest}} && chown {{owner}} {{dest}}')).toEqual([
      'src',
      'dest',
      'owner',
    ]);
  });

  it('tolerates inner whitespace', () => {
    expect(extractVariables('echo {{ name }}')).toEqual(['name']);
  });

  it('returns nothing for a plain command', () => {
    expect(extractVariables('df -h')).toEqual([]);
  });
});
