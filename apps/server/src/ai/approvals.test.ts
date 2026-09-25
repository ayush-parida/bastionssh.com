import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  APPROVAL_TIMEOUT_MS,
  pendingApprovalCount,
  resolveApproval,
  waitForApproval,
} from './approvals.js';

const alice = { orgId: 'org-1', userId: 'alice' };
const bob = { orgId: 'org-1', userId: 'bob' };
const aliceElsewhere = { orgId: 'org-2', userId: 'alice' };

afterEach(() => {
  vi.useRealTimers();
});

describe('approvals registry', () => {
  it('resolves with the owner decision and forgets the entry', async () => {
    const approved = waitForApproval('call-1', alice);
    expect(pendingApprovalCount()).toBe(1);
    expect(resolveApproval('call-1', alice, true)).toBe(true);
    await expect(approved).resolves.toBe('approved');

    const denied = waitForApproval('call-2', alice);
    expect(resolveApproval('call-2', alice, false)).toBe(true);
    await expect(denied).resolves.toBe('denied');

    expect(pendingApprovalCount()).toBe(0);
    // Settling twice is a no-op
    expect(resolveApproval('call-1', alice, true)).toBe(false);
  });

  it('refuses a decision from another user or org', async () => {
    const waiting = waitForApproval('call-3', alice);

    expect(resolveApproval('call-3', bob, true)).toBe(false);
    expect(resolveApproval('call-3', aliceElsewhere, true)).toBe(false);
    expect(pendingApprovalCount()).toBe(1);

    resolveApproval('call-3', alice, false);
    await expect(waiting).resolves.toBe('denied');
  });

  it('keeps equal ids from different users apart', async () => {
    const a = waitForApproval('call_0', alice);
    const b = waitForApproval('call_0', bob);
    resolveApproval('call_0', bob, true);
    await expect(b).resolves.toBe('approved');
    expect(pendingApprovalCount()).toBe(1);
    resolveApproval('call_0', alice, false);
    await expect(a).resolves.toBe('denied');
  });

  it('rejects a second wait on an id that is already pending', async () => {
    const first = waitForApproval('dup', alice);
    await expect(waitForApproval('dup', alice)).rejects.toThrow(/already waiting/);
    resolveApproval('dup', alice, true);
    await expect(first).resolves.toBe('approved');
  });

  it('expires after the timeout and cleans up', async () => {
    vi.useFakeTimers();
    const waiting = waitForApproval('call-4', alice);

    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS - 1);
    expect(pendingApprovalCount()).toBe(1);
    vi.advanceTimersByTime(1);

    await expect(waiting).resolves.toBe('expired');
    expect(pendingApprovalCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(resolveApproval('call-4', alice, true)).toBe(false);
  });

  it('honours a custom timeout', async () => {
    vi.useFakeTimers();
    const waiting = waitForApproval('call-5', alice, { timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    await expect(waiting).resolves.toBe('expired');
  });

  it('cancels when the signal aborts and clears the timer', async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const waiting = waitForApproval('call-6', alice, { signal: ctrl.signal });

    ctrl.abort();

    await expect(waiting).resolves.toBe('cancelled');
    expect(pendingApprovalCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is cancelled straight away when the signal already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(waitForApproval('call-7', alice, { signal: ctrl.signal })).resolves.toBe(
      'cancelled',
    );
    expect(pendingApprovalCount()).toBe(0);
  });
});
