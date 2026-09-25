/**
 * In-memory registry of AI commands waiting for the user to approve or deny
 * them. The chat stream parks on `waitForApproval` while the browser shows an
 * approval card; `POST /api/ai/approvals/:id` settles it.
 *
 * Entries are keyed by the provider's tool-call id *and* the owning org and
 * user, so nobody else can settle (or even find) someone's pending command, and
 * two users whose providers happen to reuse an id never collide. Every entry is
 * removed when it settles — by a decision, the timeout, or the client going
 * away — so nothing outlives its chat request.
 */

/** How long a command may wait for a decision before it is denied. */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export type ApprovalOutcome =
  /** The user approved the command */
  | 'approved'
  /** The user denied the command */
  | 'denied'
  /** Nobody decided within the timeout */
  | 'expired'
  /** The chat stream closed (Stop, panel closed, network drop) */
  | 'cancelled';

export interface ApprovalOwner {
  orgId: string;
  userId: string;
}

const pending = new Map<string, (outcome: ApprovalOutcome) => void>();

const keyOf = (id: string, owner: ApprovalOwner) => `${owner.orgId}\0${owner.userId}\0${id}`;

/**
 * Register a pending approval and wait for it to settle. Resolves to `expired`
 * after `timeoutMs` and to `cancelled` as soon as `signal` aborts.
 */
export function waitForApproval(
  id: string,
  owner: ApprovalOwner,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ApprovalOutcome> {
  const key = keyOf(id, owner);
  if (pending.has(key)) {
    return Promise.reject(new Error('A command with this id is already waiting for approval'));
  }
  if (opts.signal?.aborted) return Promise.resolve('cancelled');

  return new Promise((resolve) => {
    const onAbort = () => settle('cancelled');
    const timer = setTimeout(() => settle('expired'), opts.timeoutMs ?? APPROVAL_TIMEOUT_MS);

    function settle(outcome: ApprovalOutcome) {
      if (pending.get(key) !== settle) return;
      pending.delete(key);
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    }

    pending.set(key, settle);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Settle a pending approval on behalf of `owner`. Returns false when there is
 * no such approval for that user — already settled, expired, or someone else's.
 */
export function resolveApproval(id: string, owner: ApprovalOwner, approved: boolean): boolean {
  const settle = pending.get(keyOf(id, owner));
  if (!settle) return false;
  settle(approved ? 'approved' : 'denied');
  return true;
}

/** Number of approvals currently waiting (for tests and diagnostics). */
export function pendingApprovalCount(): number {
  return pending.size;
}
