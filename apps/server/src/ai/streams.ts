/**
 * Registry of in-flight AI agent streams, so a stream can be stopped from
 * outside its request when the user's access is revoked (suspension, removal,
 * a narrowed server grant, a password reset, "sign out everywhere").
 *
 * Aborting a stream's controller does what the browser closing it does: any
 * command waiting for approval is cancelled and the agent loop stops before
 * its next tool call.
 */

interface ActiveStream {
  userId: string;
  orgId: string;
  controller: AbortController;
}

const streams = new Set<ActiveStream>();

/**
 * Track a stream for its lifetime. Returns the signal to abort on and a
 * release function that must be called when the stream ends.
 */
export function registerAgentStream(
  owner: { userId: string; orgId: string },
  controller = new AbortController(),
): { signal: AbortSignal; release: () => void } {
  const entry: ActiveStream = { ...owner, controller };
  streams.add(entry);
  return { signal: controller.signal, release: () => streams.delete(entry) };
}

/**
 * Abort every stream the user has open — in one org when `orgId` is given,
 * otherwise everywhere. Returns how many were aborted.
 */
export function abortAgentStreams(userId: string, scope: { orgId?: string } = {}): number {
  let aborted = 0;
  for (const entry of [...streams]) {
    if (entry.userId !== userId) continue;
    if (scope.orgId && entry.orgId !== scope.orgId) continue;
    streams.delete(entry);
    entry.controller.abort(new Error('Access revoked'));
    aborted++;
  }
  return aborted;
}

/** Streams currently open (for tests and diagnostics). */
export function activeAgentStreamCount(): number {
  return streams.size;
}
