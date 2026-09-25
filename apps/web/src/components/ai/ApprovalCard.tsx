import { useState } from 'react';
import { ShieldAlert, Check, X, Clock, Loader2, Server } from 'lucide-react';
import { api, ApiError } from '@/lib/api.js';

export type ApprovalStatus = 'waiting' | 'approved' | 'denied' | 'expired';

/** Approval state carried on a tool call the agent paused for the user. */
export interface ToolApproval {
  status: ApprovalStatus;
  reason: string;
  serverId?: string;
  serverName?: string;
}

/**
 * Mark approvals still waiting as `status` — used when the stream ends, since
 * the server denies any undecided command once the chat request closes.
 */
export function settleWaitingApprovals<T extends { approval?: ToolApproval }>(
  toolCalls: T[],
  status: Exclude<ApprovalStatus, 'waiting'>,
): T[] {
  return toolCalls.map((tc) =>
    tc.approval?.status === 'waiting' ? { ...tc, approval: { ...tc.approval, status } } : tc,
  );
}

const STYLES = {
  /** Theme tokens, for the full-page chat */
  app: {
    card: 'border-amber-500/40 bg-amber-500/5',
    title: 'text-amber-500',
    muted: 'text-muted-foreground',
    code: 'bg-background/60 text-foreground',
    approve: 'bg-primary text-primary-foreground hover:bg-primary/90',
    deny: 'border border-border text-foreground hover:bg-muted',
    approved: 'text-green-500',
    denied: 'text-destructive',
    error: 'text-destructive',
  },
  /** The terminal sidebar's fixed dark palette */
  terminal: {
    card: 'border-[#d29922]/50 bg-[#d29922]/5',
    title: 'text-[#d29922]',
    muted: 'text-[#8b949e]',
    code: 'bg-[#0d1117] text-[#c9d1d9]',
    approve: 'bg-[#238636] text-white hover:bg-[#2ea043]',
    deny: 'border border-[#30363d] text-[#c9d1d9] hover:bg-[#21262d]',
    approved: 'text-[#3fb950]',
    denied: 'text-[#ff7b72]',
    error: 'text-[#ff7b72]',
  },
};

/**
 * Shown when the agent wants to run a command that could change a server.
 * Approve / Deny post the decision; the card's final state comes from the
 * stream's `approval_resolved` event via `approval.status`.
 */
export function ApprovalCard({
  toolCallId,
  command,
  approval,
  variant,
}: {
  toolCallId: string;
  command: string;
  approval: ToolApproval;
  variant: keyof typeof STYLES;
}) {
  const s = STYLES[variant];
  const [submitting, setSubmitting] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState('');

  async function decide(approved: boolean) {
    setSubmitting(approved ? 'approve' : 'deny');
    setError('');
    try {
      await api.post(`/ai/approvals/${encodeURIComponent(toolCallId)}`, { approved });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'This request is no longer pending.'
          : err instanceof Error
            ? err.message
            : 'Could not send your decision.',
      );
      setSubmitting(null);
    }
  }

  const waiting = approval.status === 'waiting';

  return (
    <div className={`space-y-1.5 rounded border px-2.5 py-2 text-xs ${s.card}`}>
      <div className="flex items-center gap-1.5">
        <ShieldAlert size={12} className={s.title} />
        <span className={`font-medium ${s.title}`}>
          {waiting ? 'Approval needed' : 'Command approval'}
        </span>
        <StatusBadge status={approval.status} styles={s} />
      </div>

      <pre
        className={`whitespace-pre-wrap break-all rounded p-1.5 font-mono text-[11px] ${s.code}`}
      >
        {command}
      </pre>

      <div className={`flex items-center gap-1 text-[10px] ${s.muted}`}>
        <Server size={10} />
        <span>{approval.serverName ?? approval.serverId ?? 'current session server'}</span>
      </div>
      <p className={`text-[10px] ${s.muted}`}>{approval.reason}</p>

      {waiting && (
        <div className="flex gap-1.5 pt-0.5">
          <button
            onClick={() => void decide(true)}
            disabled={submitting !== null}
            className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${s.approve}`}
          >
            {submitting === 'approve' ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Check size={11} />
            )}
            Approve
          </button>
          <button
            onClick={() => void decide(false)}
            disabled={submitting !== null}
            className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${s.deny}`}
          >
            {submitting === 'deny' ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <X size={11} />
            )}
            Deny
          </button>
        </div>
      )}
      {error && <p className={`text-[10px] ${s.error}`}>{error}</p>}
    </div>
  );
}

function StatusBadge({
  status,
  styles,
}: {
  status: ApprovalStatus;
  styles: (typeof STYLES)[keyof typeof STYLES];
}) {
  switch (status) {
    case 'waiting':
      return (
        <span className={`ml-auto flex items-center gap-1 text-[10px] ${styles.muted}`}>
          <Loader2 size={10} className="animate-spin" /> waiting
        </span>
      );
    case 'approved':
      return (
        <span className={`ml-auto flex items-center gap-1 text-[10px] ${styles.approved}`}>
          <Check size={10} /> approved
        </span>
      );
    case 'denied':
      return (
        <span className={`ml-auto flex items-center gap-1 text-[10px] ${styles.denied}`}>
          <X size={10} /> denied
        </span>
      );
    case 'expired':
      return (
        <span className={`ml-auto flex items-center gap-1 text-[10px] ${styles.muted}`}>
          <Clock size={10} /> expired
        </span>
      );
  }
}
