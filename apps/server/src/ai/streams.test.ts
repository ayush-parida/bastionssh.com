import { describe, it, expect } from 'vitest';
import { abortAgentStreams, activeAgentStreamCount, registerAgentStream } from './streams.js';
import { pendingApprovalCount, waitForApproval } from './approvals.js';

describe('agent stream registry', () => {
  it('aborts a user’s streams, optionally in one org, and cancels their pending approvals', async () => {
    const inA = registerAgentStream({ userId: 'u1', orgId: 'a' });
    const inB = registerAgentStream({ userId: 'u1', orgId: 'b' });
    const someoneElse = registerAgentStream({ userId: 'u2', orgId: 'a' });
    const waiting = waitForApproval('call-1', { userId: 'u1', orgId: 'a' }, { signal: inA.signal });
    expect(pendingApprovalCount()).toBe(1);

    expect(abortAgentStreams('u1', { orgId: 'a' })).toBe(1);
    expect(inA.signal.aborted).toBe(true);
    expect(inB.signal.aborted).toBe(false);
    await expect(waiting).resolves.toBe('cancelled');
    expect(pendingApprovalCount()).toBe(0);

    expect(abortAgentStreams('u1')).toBe(1);
    expect(inB.signal.aborted).toBe(true);
    expect(someoneElse.signal.aborted).toBe(false);

    someoneElse.release();
    inA.release();
    inB.release();
    expect(activeAgentStreamCount()).toBe(0);
  });

  it('forgets a released stream', () => {
    const s = registerAgentStream({ userId: 'u3', orgId: 'a' });
    s.release();
    expect(abortAgentStreams('u3')).toBe(0);
    expect(s.signal.aborted).toBe(false);
  });
});
