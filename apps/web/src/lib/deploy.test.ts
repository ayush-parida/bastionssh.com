import { describe, expect, it } from 'vitest';
import { deployUploadPath } from './deploy.js';

describe('the deploy upload path', () => {
  it("carries the Deploy dialog's choices only when made", () => {
    expect(deployUploadPath('s1', 'site1')).toBe('/deploy/servers/s1/apps/site1/deploy');
    expect(deployUploadPath('s1', 'site1', { where: 'bastion' })).toBe('/deploy/servers/s1/apps/site1/deploy?where=bastion');
    expect(deployUploadPath('s1', 'site1', { where: 'server', includeEnvFiles: true })).toBe('/deploy/servers/s1/apps/site1/deploy?where=server&includeEnvFiles=true');
    expect(deployUploadPath('s 1', 'site1', { includeEnvFiles: false })).toBe('/deploy/servers/s%201/apps/site1/deploy');
  });
});
