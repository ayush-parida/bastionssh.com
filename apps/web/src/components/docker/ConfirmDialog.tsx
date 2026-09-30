import { useEffect, useRef, useState } from 'react';
import { Loader2, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/utils.js';

export interface ConfirmOption {
  key: string;
  label: string;
  hint?: string;
}

/**
 * Confirmation for a Docker action that cannot be taken back. It names what
 * it acts on (`subject`, in monospace) so the right container or image is
 * clear, offers `options` as checkboxes (force, remove volumes), and stays
 * open with the error when the action fails.
 */
export default function ConfirmDialog({
  title,
  subject,
  children,
  confirmLabel,
  danger = true,
  options = [],
  onConfirm,
  onClose,
}: {
  title: string;
  subject: string;
  children?: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  options?: ConfirmOption[];
  onConfirm: (options: Record<string, boolean>) => Promise<unknown>;
  onClose: () => void;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => confirmRef.current?.focus(), []);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(checked);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onClose();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="docker-confirm-title"
        className="flex w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          {danger && <TriangleAlert size={16} className="shrink-0 text-red-500" />}
          <span id="docker-confirm-title" className="flex-1 truncate text-sm font-semibold">
            {title}
          </span>
          <button onClick={onClose} disabled={busy} className="text-muted-foreground hover:text-foreground disabled:opacity-40" title="Close">
            <X size={14} />
          </button>
        </div>
        <div className="space-y-3 p-4 text-sm">
          <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">{subject}</p>
          {children}
          {options.map((o) => (
            <label key={o.key} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={!!checked[o.key]}
                onChange={(e) => setChecked((c) => ({ ...c, [o.key]: e.target.checked }))}
              />
              <span>
                {o.label}
                {o.hint && <span className="block text-xs text-muted-foreground">{o.hint}</span>}
              </span>
            </label>
          ))}
          {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button onClick={onClose} disabled={busy} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50">
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={() => void confirm()}
            disabled={busy}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50',
              danger ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
