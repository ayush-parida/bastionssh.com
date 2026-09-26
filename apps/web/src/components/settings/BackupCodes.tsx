import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { relativeTime } from '@/lib/utils.js';
import { isPasskeyCancel, passkeyErrorMessage, withStepUp } from '@/lib/passkeys.js';
import type { BackupCodeStatus, GeneratedBackupCodes } from '@smt/shared';
import { Copy, Download, KeyRound, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';

/** Few enough left that the next lost passkey could leave someone stuck. */
export const LOW_BACKUP_CODES = 2;

/** Codes are worth a warning when none were ever made, or when they are running out. */
export function backupCodesNeedAttention(status: BackupCodeStatus | undefined): boolean {
  return !!status && (status.total === 0 || status.remaining <= LOW_BACKUP_CODES);
}

/** Make a new set, confirming a passkey first if this session has not used one. */
export function useGenerateBackupCodes(onGenerated: (codes: string[]) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => withStepUp(() => api.post<GeneratedBackupCodes>('/auth/backup-codes')),
    // The response holds the plaintext codes: do not keep it in the mutation cache once the dialog is gone
    gcTime: 0,
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['backup-codes'] });
      qc.invalidateQueries({ queryKey: ['auth-me'] });
      onGenerated(res.codes);
    },
    onError: (err: Error) => { if (!isPasskeyCancel(err)) toast.error(passkeyErrorMessage(err)); },
  });
}

/**
 * The only time a set of codes is ever shown. It stays open until the user
 * says they have saved them — closing it loses them for good.
 */
export function BackupCodesDialog({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const [saved, setSaved] = useState(false);
  const text = codes.join('\n');

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Backup codes copied');
    } catch {
      toast.message('Select the codes and copy them by hand', { duration: 10_000 });
    }
  }

  function download() {
    const body = [
      'Server Management Tool — backup codes',
      `Generated ${new Date().toUTCString()}`,
      'Each code signs you in once, after your password, if you cannot use your passkey.',
      '',
      ...codes,
      '',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'backup-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onKeyDown={(e) => { if (e.key === 'Escape' && saved) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="backup-codes-title"
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <KeyRound size={16} className="text-primary shrink-0" />
          <span id="backup-codes-title" className="flex-1 truncate text-sm font-semibold">Your backup codes</span>
          <button onClick={onClose} disabled={!saved} className="text-muted-foreground hover:text-foreground disabled:opacity-40" title="Close">
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            <TriangleAlert size={15} className="mt-0.5 shrink-0" />
            <p>Save these now — they won't be shown again. Each one signs you in once, after your password, if you lose your passkey.</p>
          </div>
          <ol className="grid grid-cols-2 gap-2 rounded-md border border-border bg-background p-3 font-mono text-sm">
            {codes.map((c) => <li key={c} className="text-center tracking-wider select-all">{c}</li>)}
          </ol>
          <div className="flex gap-2">
            <button
              onClick={copyAll}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
            >
              <Copy size={14} /> Copy all
            </button>
            <button
              onClick={download}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
            >
              <Download size={14} /> Download .txt
            </button>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
              className="size-4 rounded border-input"
            />
            I have saved these codes
          </label>
        </div>
        <div className="flex justify-end border-t border-border px-4 py-3">
          <button
            onClick={onClose}
            disabled={!saved}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The backup-codes card under the passkey list. `suggest` highlights it right
 * after a first passkey, when there is not yet any way back in without it.
 */
export default function BackupCodes({ status, suggest }: { status: BackupCodeStatus | undefined; suggest: boolean }) {
  const [shown, setShown] = useState<string[] | null>(null);
  const generate = useGenerateBackupCodes(setShown);
  const hasSet = !!status && status.total > 0;
  const attention = backupCodesNeedAttention(status);

  function start() {
    if (hasSet && !confirm('Generate new backup codes? Your current codes will stop working.')) return;
    generate.mutate();
  }

  return (
    <div
      className={`mt-4 rounded-lg border bg-card p-4 ${suggest && !hasSet ? 'border-primary/50 ring-1 ring-primary/30' : 'border-border'}`}
    >
      <div className="flex items-start gap-3">
        <KeyRound size={16} className="mt-0.5 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Backup codes</p>
          <p className="text-xs text-muted-foreground">
            {!status
              ? 'Loading…'
              : hasSet
                ? `${status.remaining} of ${status.total} left · generated ${relativeTime(status.createdAt!)}`
                : 'One-time codes that sign you in, after your password, if you lose your passkeys.'}
          </p>
          {suggest && !hasSet && (
            <p className="mt-2 text-sm">Your passkey is set up. Generate backup codes now so a lost device cannot lock you out.</p>
          )}
          {attention && hasSet && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              {status!.remaining === 0
                ? 'You have used every code. Generate a new set.'
                : 'You are running low. Generate a new set.'}
            </p>
          )}
        </div>
        <button
          onClick={start}
          disabled={generate.isPending || !status}
          className={
            hasSet && !attention
              ? 'shrink-0 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50'
              : 'shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50'
          }
        >
          {generate.isPending ? 'Generating…' : hasSet ? 'Regenerate' : 'Generate'}
        </button>
      </div>
      {shown && <BackupCodesDialog codes={shown} onClose={() => setShown(null)} />}
    </div>
  );
}
