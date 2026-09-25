import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runCronJob: vi.fn(async (_data: { cronJobId: string; scheduledAt: string }) => {}),
  scheduleCronJob: vi.fn(async (_id: string, _after?: Date) => {}),
}));
vi.mock('bullmq', () => ({ Worker: vi.fn() }));
vi.mock('./processors/command.js', () => ({ runCommandJob: vi.fn() }));
vi.mock('./processors/cron.js', () => ({ runCronJob: mocks.runCronJob }));
vi.mock('./scheduler.js', () => ({
  scheduleCronJob: mocks.scheduleCronJob,
  syncCronSchedules: vi.fn(async () => {}),
}));

import { processCronQueueJob } from './index.js';

describe('cron queue processor', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.runCronJob.mockReset().mockResolvedValue(undefined);
    mocks.scheduleCronJob.mockReset().mockResolvedValue(undefined);
  });

  it('runs the occurrence, then queues the next one after it', async () => {
    const scheduledAt = new Date(Date.now() + 60_000).toISOString();
    await processCronQueueJob({ cronJobId: 'c1', scheduledAt });

    expect(mocks.runCronJob).toHaveBeenCalledWith({ cronJobId: 'c1', scheduledAt });
    expect(mocks.scheduleCronJob).toHaveBeenCalledTimes(1);
    const [id, after] = mocks.scheduleCronJob.mock.calls[0]!;
    expect(id).toBe('c1');
    // Fired early: the next run is computed from the scheduled time, not "now".
    expect(after!.toISOString()).toBe(scheduledAt);
    expect(mocks.runCronJob.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.scheduleCronJob.mock.invocationCallOrder[0]!,
    );
  });

  it('uses the current time when the occurrence fired late', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T12:05:00Z') });
    await processCronQueueJob({ cronJobId: 'c1', scheduledAt: '2026-01-01T12:00:00.000Z' });
    expect(mocks.scheduleCronJob.mock.calls[0]![1]!.toISOString()).toBe('2026-01-01T12:05:00.000Z');
  });

  it('still queues the next run when the command throws, and rethrows', async () => {
    mocks.runCronJob.mockRejectedValue(new Error('ssh down'));
    await expect(
      processCronQueueJob({ cronJobId: 'c2', scheduledAt: new Date().toISOString() }),
    ).rejects.toThrow('ssh down');
    expect(mocks.scheduleCronJob).toHaveBeenCalledWith('c2', expect.any(Date));
  });

  it('does not fail the job when queueing the next run fails', async () => {
    mocks.scheduleCronJob.mockRejectedValue(new Error('redis gone'));
    await expect(
      processCronQueueJob({ cronJobId: 'c3', scheduledAt: new Date().toISOString() }),
    ).resolves.toBeUndefined();
  });
});
