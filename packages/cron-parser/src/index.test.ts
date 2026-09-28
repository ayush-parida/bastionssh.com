import { describe, expect, it } from 'vitest';
import { describeCron, getNextRun, parseCronSchedule } from './index.js';

describe('parseCronSchedule', () => {
  it('returns the requested number of upcoming runs, in order', () => {
    const parsed = parseCronSchedule('*/5 * * * *', 'UTC', 3);
    expect(parsed.isValid).toBe(true);
    expect(parsed.nextRuns).toHaveLength(3);
    const [a, b, c] = parsed.nextRuns as [Date, Date, Date];
    expect(b.getTime() - a.getTime()).toBe(5 * 60_000);
    expect(c.getTime() - b.getTime()).toBe(5 * 60_000);
  });

  it('reports an invalid expression instead of throwing', () => {
    const parsed = parseCronSchedule('not a cron');
    expect(parsed.isValid).toBe(false);
    expect(parsed.nextRuns).toEqual([]);
    expect(parsed.error).toBeTruthy();
  });
});

describe('getNextRun', () => {
  it('returns the next run after the given date', () => {
    const next = getNextRun('0 3 * * *', 'UTC', new Date('2024-01-01T12:00:00Z'));
    expect(next?.toISOString()).toBe('2024-01-02T03:00:00.000Z');
  });

  it('returns null for an invalid expression', () => {
    expect(getNextRun('nope')).toBeNull();
  });
});

describe('describeCron', () => {
  it.each([
    ['* * * * *', 'Every minute'],
    ['15 * * * *', 'Every hour at minute 15'],
    ['5 3 * * *', 'Daily at 3:05'],
    ['0 9 * * 1', 'Weekly on weekday 1 at 9:00'],
    ['30 2 1 * *', 'Monthly on day 1 at 2:30'],
    ['0 0 1 1 *', '0 0 1 1 *'],
    ['bad', 'bad'],
  ])('%s -> %s', (expr, text) => {
    expect(describeCron(expr)).toBe(text);
  });
});
