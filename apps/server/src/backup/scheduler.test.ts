import { describe, expect, it } from 'vitest';
import { backupDue } from './scheduler.js';

describe('backupDue', () => {
  const now = new Date('2026-09-28T12:00:00Z');

  it('is due with no scheduled backup yet', () => {
    expect(backupDue(null, 24, now)).toBe(true);
  });

  it('waits for the interval since the newest scheduled backup, with a minute of slack', () => {
    expect(backupDue(new Date('2026-09-28T00:00:00Z'), 24, now)).toBe(false);
    expect(backupDue(new Date('2026-09-27T12:00:30Z'), 24, now)).toBe(true);
    expect(backupDue(new Date('2026-09-27T12:02:00Z'), 24, now)).toBe(false);
    expect(backupDue(new Date('2026-09-28T11:00:00Z'), 1, now)).toBe(true);
  });

  it('never, when scheduled backups are off', () => {
    expect(backupDue(null, 0, now)).toBe(false);
  });
});
