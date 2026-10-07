import { describe, expect, it } from 'vitest';
import { fillSecrets, MASK } from '@/components/deploy/ConnectionPanel.js';

describe('connection strings', () => {
  it('fills revealed secrets and masks the rest', () => {
    const url = 'postgres://app:{POSTGRES_PASSWORD}@orders-db:5432/app';
    expect(fillSecrets(url, {})).toBe(`postgres://app:${MASK}@orders-db:5432/app`);
    expect(fillSecrets(url, { POSTGRES_PASSWORD: 's3cret' })).toBe('postgres://app:s3cret@orders-db:5432/app');
    expect(fillSecrets('mysql://{A}:{B}@h', { A: 'root' })).toBe(`mysql://root:${MASK}@h`);
  });
});
