import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HostKeyScanResult, HostKeyStatus, Server, ServerHostKey } from '@smt/shared';
import { Copy, KeyRound, ScanLine, ShieldAlert, ShieldCheck, ShieldQuestion, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { useAccessLevels } from '@/hooks/useAccessLevels.js';
import { cn, relativeTime } from '@/lib/utils.js';
import { hostKeyPanelPath } from '@/lib/host-keys.js';

const STATUS: Record<HostKeyStatus, { label: string; className: string; icon: typeof ShieldCheck; title: string }> = {
  unknown: {
    label: 'Host key unknown',
    className: 'bg-muted text-muted-foreground',
    icon: ShieldQuestion,
    title: 'No host key pinned yet — the next connection trusts whatever key the host presents',
  },
  trusted: {
    label: 'Host key trusted',
    className: 'bg-emerald-500/10 text-emerald-600',
    icon: ShieldCheck,
    title: 'Connections are only made when the host presents the pinned key',
  },
  mismatch: {
    label: 'Host key changed',
    className: 'bg-red-500/10 text-red-600',
    icon: ShieldAlert,
    title: 'The host presented a different key — connections are refused until an admin reviews it',
  },
};

/** Compact status pill for a server's host key. */
export function HostKeyBadge({ status, className }: { status: HostKeyStatus; className?: string }) {
  const meta = STATUS[status] ?? STATUS.unknown;
  const Icon = meta.icon;
  return (
    <span
      title={meta.title}
      className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs', meta.className, className)}
    >
      <Icon size={11} />
      {meta.label}
    </span>
  );
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success('Fingerprint copied');
  } catch {
    toast.error('Could not copy — select the fingerprint and copy it manually');
  }
}

/** Monospace fingerprint with a copy button. */
export function Fingerprint({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs" title={value}>
        {value}
      </code>
      <button
        type="button"
        onClick={() => void copy(value)}
        title="Copy fingerprint"
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Copy size={12} />
      </button>
    </span>
  );
}

/**
 * Shown wherever a connection was refused over a changed host key: what was
 * expected, what the host presented, and the way to the panel that resolves it.
 */
export function HostKeyMismatchNotice({
  serverId,
  expected,
  presented,
  className,
}: {
  serverId: string;
  expected?: string;
  presented?: string;
  className?: string;
}) {
  return (
    <div className={cn('rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-sm', className)}>
      <p className="flex items-center gap-2 font-medium text-red-600">
        <ShieldAlert size={16} />
        SSH host key verification failed
      </p>
      <p className="mt-1 text-muted-foreground">
        This server presented a different host key than the one pinned for it, so the connection was
        refused before any credentials were sent. This can mean the server was reinstalled — or that
        someone is intercepting the connection.
      </p>
      {(expected || presented) && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {expected && (
            <>
              <dt className="text-muted-foreground">Expected</dt>
              <dd className="truncate font-mono">{expected}</dd>
            </>
          )}
          {presented && (
            <>
              <dt className="text-muted-foreground">Presented</dt>
              <dd className="truncate font-mono text-red-600">{presented}</dd>
            </>
          )}
        </dl>
      )}
      <Link to={hostKeyPanelPath(serverId)} className="mt-3 inline-block text-xs font-medium text-primary hover:underline">
        Review the host key →
      </Link>
    </div>
  );
}

const VERIFY_HINT = 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub';

/**
 * Host key panel for one server: status and fingerprint for everyone who can
 * see the server; scan & pin, accept a changed key and forget for admins.
 */
export function HostKeyPanel({ serverId }: { serverId: string }) {
  const qc = useQueryClient();
  const location = useLocation();
  // Pinning, accepting and forgetting the key need `manage` on the server (custom roles spec §5)
  const canManage = useAccessLevels('server').can(serverId, 'manage');
  const panelRef = useRef<HTMLDivElement>(null);
  const [scan, setScan] = useState<HostKeyScanResult | null>(null);

  const { data: server } = useQuery<Server>({
    queryKey: ['servers', serverId],
    queryFn: () => api.get(`/servers/${serverId}`),
  });

  // Only admins may read the trust details and mismatch evidence
  const { data: hostKey } = useQuery<ServerHostKey>({
    queryKey: ['host-key', serverId],
    queryFn: () => api.get(`/servers/${serverId}/host-key`),
    enabled: canManage,
  });

  // Linked to from connection errors: bring the panel into view
  useEffect(() => {
    if (location.hash === '#host-key' && server) {
      panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [location.hash, server]);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['host-key', serverId] });
    void qc.invalidateQueries({ queryKey: ['servers'] });
    void qc.invalidateQueries({ queryKey: ['server-health', serverId] });
    void qc.invalidateQueries({ queryKey: ['monitoring-overview'] });
  }

  const scanMutation = useMutation({
    mutationFn: () => api.post<HostKeyScanResult>(`/servers/${serverId}/host-key/scan`),
    onSuccess: (result) => setScan(result),
    onError: (err: Error) => toast.error(err.message),
  });

  const pinMutation = useMutation({
    mutationFn: (fingerprint: string) => api.put<ServerHostKey>(`/servers/${serverId}/host-key`, { fingerprint }),
    onSuccess: () => {
      setScan(null);
      refresh();
      toast.success('Host key pinned');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const acceptMutation = useMutation({
    mutationFn: (fingerprint: string) =>
      api.post<ServerHostKey>(`/servers/${serverId}/host-key/accept`, { fingerprint }),
    onSuccess: () => {
      refresh();
      toast.success('New host key accepted');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const forgetMutation = useMutation({
    mutationFn: () => api.delete(`/servers/${serverId}/host-key`),
    onSuccess: () => {
      refresh();
      toast.success('Host key forgotten — the next connection will trust the key it sees');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (!server) return null;

  const fingerprint = hostKey?.fingerprint ?? server.hostKeyFingerprint;
  const mismatch = hostKey?.mismatch;

  function confirmPin(result: HostKeyScanResult) {
    const ok = confirm(
      `Pin ${result.fingerprint} (${result.type})?\n\n` +
        `Only confirm if it matches what the server itself reports. On the server, run:\n\n  ${VERIFY_HINT}\n\n` +
        '(or the .pub file for the key type shown). A scan cannot tell a real host from an impostor.',
    );
    if (ok) pinMutation.mutate(result.fingerprint);
  }

  function confirmAccept() {
    if (!mismatch) return;
    const ok = confirm(
      'WARNING: the host key for this server changed.\n\n' +
        `Expected:  ${fingerprint}\nPresented: ${mismatch.fingerprint}\n\n` +
        'Accept only if you know why it changed (e.g. the server was rebuilt) and you have checked the new ' +
        `fingerprint on the server with:\n\n  ${VERIFY_HINT}\n\n` +
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
    <div
      id="host-key"
      ref={panelRef}
      className={cn(
        'mb-6 scroll-mt-6 rounded-lg border bg-card p-4',
        server.hostKeyStatus === 'mismatch' ? 'border-red-500/40' : 'border-border',
      )}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <KeyRound size={16} className="text-muted-foreground" />
        <h2 className="font-semibold">SSH host key</h2>
        <HostKeyBadge status={server.hostKeyStatus} />
        {canManage && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              onClick={() => scanMutation.mutate()}
              disabled={scanMutation.isPending}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-muted disabled:opacity-50"
            >
              <ScanLine size={13} />
              {scanMutation.isPending ? 'Scanning…' : 'Scan & pin'}
            </button>
            {(fingerprint || mismatch) && (
              <button
                onClick={confirmForget}
                disabled={forgetMutation.isPending}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
              >
                <Trash2 size={13} />
                Forget key
              </button>
            )}
          </div>
        )}
      </div>

      {fingerprint ? (
        <div className="space-y-1 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <span className="w-20 shrink-0 text-xs text-muted-foreground">Fingerprint</span>
            <Fingerprint value={fingerprint} />
            {hostKey?.type && <span className="text-xs text-muted-foreground">{hostKey.type}</span>}
          </div>
          {hostKey?.trustedAt && (
            <p className="text-xs text-muted-foreground">
              {hostKey.trustedBy ? 'Pinned by an admin' : 'Trusted on first connection'}{' '}
              {relativeTime(hostKey.trustedAt)}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No host key pinned. The first connection will trust the key the host presents and remember
          it{canManage ? ' — or scan and pin it now after checking it on the server.' : '.'}
        </p>
      )}

      {server.hostKeyStatus === 'mismatch' && !canManage && (
        <p className="mt-3 text-sm text-red-600">
          The host presented a different key. Connections are refused until an admin reviews it.
        </p>
      )}

      {mismatch && (
        <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium text-red-600">
            <ShieldAlert size={15} />
            The host presented a different key {mismatch.seenAt && relativeTime(mismatch.seenAt)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Every connection is being refused. If the server was not rebuilt or re-keyed on purpose,
            treat this as a possible man-in-the-middle and do not accept it.
          </p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Expected</dt>
            <dd className="min-w-0">{fingerprint && <Fingerprint value={fingerprint} />}</dd>
            <dt className="text-muted-foreground">Presented</dt>
            <dd className="min-w-0">
              <Fingerprint value={mismatch.fingerprint} />
              {mismatch.type && <span className="ml-2 text-muted-foreground">{mismatch.type}</span>}
            </dd>
          </dl>
          <button
            onClick={confirmAccept}
            disabled={acceptMutation.isPending}
            className="mt-3 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Accept new key…
          </button>
        </div>
      )}

      {scan && (
        <div className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-sm">
          <p className="font-medium">The host presents</p>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <Fingerprint value={scan.fingerprint} />
            <span className="text-xs text-muted-foreground">{scan.type}</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Before pinning, confirm it matches what the server reports locally:{' '}
            <code className="rounded bg-muted px-1 font-mono">{VERIFY_HINT}</code>
          </p>
          {fingerprint && scan.fingerprint !== fingerprint && (
            <p className="mt-2 text-xs text-red-600">This differs from the pinned fingerprint.</p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => confirmPin(scan)}
              disabled={pinMutation.isPending}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              It matches — pin it
            </button>
            <button
              onClick={() => setScan(null)}
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
