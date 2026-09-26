import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HOST_KEY_FINGERPRINT_PATTERN, type FtpConnection, type FtpHostKey } from '@smt/shared';
import { ShieldAlert, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { useHasRole } from '@/store/auth.js';
import { relativeTime } from '@/lib/utils.js';
import { Fingerprint, HostKeyBadge } from '@/components/servers/HostKey.js';

const VERIFY_HINT = 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub';

/**
 * Host key status for an SFTP connection card: the badge and fingerprint for
 * everyone; pin, accept a changed key and forget for admins. Same trust model
 * as a server's host key panel, compacted to fit a card.
 */
export function FtpHostKeySection({ connection }: { connection: FtpConnection }) {
  const qc = useQueryClient();
  const isAdmin = useHasRole('admin');
  const [pinning, setPinning] = useState(false);
  const [draft, setDraft] = useState('');
  const base = `/ftp/connections/${connection.id}/host-key`;

  // Only admins may read the trust details and mismatch evidence
  const { data: hostKey } = useQuery<FtpHostKey>({
    queryKey: ['ftp-host-key', connection.id, connection.hostKeyStatus, connection.hostKeyFingerprint],
    queryFn: () => api.get(base),
    enabled: isAdmin,
  });

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['ftp-host-key', connection.id] });
    void qc.invalidateQueries({ queryKey: ['ftp-connections'] });
  }

  const pinMutation = useMutation({
    mutationFn: (fingerprint: string) => api.put<FtpHostKey>(base, { fingerprint }),
    onSuccess: () => {
      setPinning(false);
      setDraft('');
      refresh();
      toast.success('Host key pinned');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const acceptMutation = useMutation({
    mutationFn: (fingerprint: string) => api.post<FtpHostKey>(`${base}/accept`, { fingerprint }),
    onSuccess: () => {
      refresh();
      toast.success('New host key accepted');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const forgetMutation = useMutation({
    mutationFn: () => api.delete(base),
    onSuccess: () => {
      refresh();
      toast.success('Host key forgotten — the next connection will trust the key it sees');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const fingerprint = hostKey?.fingerprint ?? connection.hostKeyFingerprint;
  const mismatch = hostKey?.mismatch;

  function submitPin(e: React.FormEvent) {
    e.preventDefault();
    const value = draft.trim();
    if (!HOST_KEY_FINGERPRINT_PATTERN.test(value)) {
      toast.error('Fingerprint must look like SHA256: followed by 43 base64 characters');
      return;
    }
    pinMutation.mutate(value);
  }

  function confirmAccept() {
    if (!mismatch) return;
    const ok = confirm(
      `WARNING: the host key for "${connection.name}" changed.\n\n` +
        `Expected:  ${fingerprint}\nPresented: ${mismatch.fingerprint}\n\n` +
        'Accept only if you know why it changed (e.g. the host was rebuilt or moved) and you have checked ' +
        `the new fingerprint with the host or its provider (${VERIFY_HINT}).\n\n` +
        'If you cannot explain the change, do not accept — someone may be intercepting connections.',
    );
    if (ok) acceptMutation.mutate(mismatch.fingerprint);
  }

  function confirmForget() {
    const ok = confirm(
      'Forget the pinned host key? The next connection will trust whatever key the host presents.',
    );
    if (ok) forgetMutation.mutate();
  }

  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <HostKeyBadge status={connection.hostKeyStatus} />
        {isAdmin && (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPinning((v) => !v)}
              className="text-muted-foreground hover:bg-muted rounded px-2 py-0.5"
            >
              Pin…
            </button>
            {(fingerprint || mismatch) && (
              <button
                type="button"
                onClick={confirmForget}
                disabled={forgetMutation.isPending}
                title="Forget host key"
                className="rounded p-1 text-red-500 hover:bg-red-500/10 disabled:opacity-50"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      {fingerprint ? (
        <div className="flex min-w-0 items-center gap-2">
          <Fingerprint value={fingerprint} className="min-w-0" />
          {hostKey?.type && <span className="text-muted-foreground shrink-0">{hostKey.type}</span>}
        </div>
      ) : (
        <p className="text-muted-foreground">
          No host key yet — the first connection trusts the key the host presents.
        </p>
      )}
      {hostKey?.trustedAt && (
        <p className="text-muted-foreground">Trusted {relativeTime(hostKey.trustedAt)}</p>
      )}

      {connection.hostKeyStatus === 'mismatch' && !isAdmin && (
        <p className="text-red-600">
          The host presented a different key. Connections are refused until an admin reviews it.
        </p>
      )}

      {mismatch && (
        <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2">
          <p className="flex items-center gap-1.5 font-medium text-red-600">
            <ShieldAlert size={13} />
            Different key presented {mismatch.seenAt && relativeTime(mismatch.seenAt)}
          </p>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <span className="text-muted-foreground shrink-0">Presented</span>
            <Fingerprint value={mismatch.fingerprint} className="min-w-0" />
          </div>
          <button
            type="button"
            onClick={confirmAccept}
            disabled={acceptMutation.isPending}
            className="mt-2 rounded-md bg-red-600 px-2.5 py-1 font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            Accept new key…
          </button>
        </div>
      )}

      {pinning && (
        <form onSubmit={submitPin} className="flex gap-1.5">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="SHA256:…"
            className="border-input bg-background min-w-0 flex-1 rounded-md border px-2 py-1 font-mono focus:ring-primary focus:outline-none focus:ring-2"
          />
          <button
            type="submit"
            disabled={pinMutation.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-2.5 py-1 font-medium disabled:opacity-50"
          >
            Pin
          </button>
        </form>
      )}
    </div>
  );
}
