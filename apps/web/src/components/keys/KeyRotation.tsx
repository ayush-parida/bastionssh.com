import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { KeyRotation, KeyRotationStatus, Server, SSHKey } from '@smt/shared';
import { AlertTriangle, History, KeyRound, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, api } from '@/lib/api.js';
import { isPasskeyCancel, passkeyErrorMessage } from '@/lib/passkeys.js';
import { useHasRole } from '@/store/auth.js';
import { cn, relativeTime } from '@/lib/utils.js';
import { KEY_AGE_WARNING_DAYS, ROTATION_CONFIRM, isKeyOld, keyAgeDays, rotateServerKey, toastRotation } from '@/lib/key-rotation.js';

const STATUS: Record<KeyRotationStatus, { label: string; className: string }> = {
  pending: { label: 'Queued', className: 'bg-muted text-muted-foreground' },
  running: { label: 'Running', className: 'bg-blue-500/10 text-blue-600' },
  completed: { label: 'Completed', className: 'bg-emerald-500/10 text-emerald-600' },
  rolled_back: { label: 'Rolled back', className: 'bg-amber-500/10 text-amber-600' },
  failed: { label: 'Failed', className: 'bg-red-500/10 text-red-600' },
  interrupted: { label: 'Interrupted', className: 'bg-red-500/10 text-red-600' },
};

export function RotationStatusBadge({ status }: { status: KeyRotationStatus }) {
  const meta = STATUS[status] ?? STATUS.failed;
  return <span className={cn('inline-flex rounded px-1.5 py-0.5 text-xs', meta.className)}>{meta.label}</span>;
}

/** "Rotate me" pill for a key older than the warning age; nothing otherwise. */
export function KeyAgeBadge({ sshKey, className }: { sshKey: SSHKey; className?: string }) {
  if (!isKeyOld(sshKey)) return null;
  return (
    <span
      title={`Created ${keyAgeDays(sshKey)} days ago. Keys older than ${KEY_AGE_WARNING_DAYS} days should be rotated.`}
      className={cn('inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600', className)}
    >
      <AlertTriangle size={11} />
      Key {keyAgeDays(sshKey)}d old
    </span>
  );
}

/** Report a failed rotate request (not a failed rotation — that comes back as a record). */
export function rotationRequestError(err: unknown) {
  if (isPasskeyCancel(err)) return;
  // An API refusal says why; only a failed passkey prompt needs translating
  toast.error(err instanceof ApiError ? err.message : passkeyErrorMessage(err));
}

const isOpen = (r: KeyRotation) => r.status === 'pending' || r.status === 'running';

/** Rotation records, newest first; polls while any is still queued or running. */
export function RotationHistory({
  serverId,
  keyId,
  batchId,
  showServer = true,
  emptyText = 'No key rotations yet.',
}: {
  serverId?: string;
  keyId?: string;
  batchId?: string;
  showServer?: boolean;
  emptyText?: string;
}) {
  const params = new URLSearchParams();
  if (serverId) params.set('serverId', serverId);
  if (keyId) params.set('keyId', keyId);
  if (batchId) params.set('batchId', batchId);
  const qc = useQueryClient();

  const { data: rotations, isLoading } = useQuery<KeyRotation[]>({
    queryKey: ['key-rotations', serverId ?? null, keyId ?? null, batchId ?? null],
    queryFn: async () => {
      const list = await api.get<KeyRotation[]>(`/keys/rotations?${params}`);
      // A batch finishing changes keys and servers too
      if (!list.some(isOpen)) {
        void qc.invalidateQueries({ queryKey: ['ssh-keys'] });
        void qc.invalidateQueries({ queryKey: ['servers'] });
      }
      return list;
    },
    refetchInterval: (query) => (query.state.data?.some(isOpen) ? 2_000 : false),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!rotations?.length) return <p className="text-sm text-muted-foreground">{emptyText}</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-border bg-muted/50">
          <tr>
            {['When', ...(showServer ? ['Server'] : []), 'Status', 'Old key', 'New key', 'Details'].map((h) => (
              <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rotations.map((r) => (
            <tr key={r.id} className="align-top">
              <td className="whitespace-nowrap px-3 py-2 text-muted-foreground" title={new Date(r.createdAt).toLocaleString()}>
                {relativeTime(r.createdAt)}
              </td>
              {showServer && (
                <td className="px-3 py-2">
                  {r.serverName}
                  {!r.serverId && <span className="ml-1 text-xs text-muted-foreground">(deleted)</span>}
                </td>
              )}
              <td className="whitespace-nowrap px-3 py-2">
                <RotationStatusBadge status={r.status} />
                {r.step && isOpen(r) && <span className="ml-1 text-xs text-muted-foreground">{r.step.replace('_', ' ')}</span>}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                {r.oldFingerprint}
                {r.oldKeyRetired && <span className="ml-1 font-sans">(retired)</span>}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.newKeyId ? r.newFingerprint : '—'}</td>
              <td className="px-3 py-2 text-xs">
                {r.error && (
                  <p className={r.status === 'completed' ? 'text-amber-600' : 'text-red-600'}>
                    {r.step && !isOpen(r) && r.status !== 'completed' && <span className="font-medium">At {r.step.replace('_', ' ')}: </span>}
                    {r.error}
                  </p>
                )}
                {r.warnings.map((w) => (
                  <p key={w} className="text-amber-600">{w}</p>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The server's login key, its age, a rotate action and its rotation history. */
export function ServerKeyPanel({ serverId }: { serverId: string }) {
  const qc = useQueryClient();
  const isAdmin = useHasRole('admin');

  const { data: server } = useQuery<Server>({
    queryKey: ['servers', serverId],
    queryFn: () => api.get(`/servers/${serverId}`),
  });
  const { data: keys } = useQuery<SSHKey[]>({
    queryKey: ['ssh-keys'],
    queryFn: () => api.get('/keys'),
  });

  const rotateMutation = useMutation({
    mutationFn: () => rotateServerKey(serverId),
    onSuccess: (rotation) => {
      toastRotation(rotation);
      void qc.invalidateQueries({ queryKey: ['servers'] });
      void qc.invalidateQueries({ queryKey: ['ssh-keys'] });
      void qc.invalidateQueries({ queryKey: ['key-rotations'] });
    },
    onError: rotationRequestError,
  });

  if (!server) return null;
  const key = keys?.find((k) => k.id === server.defaultKeyId);
  const keyAuth = server.authType === 'key' && !!server.defaultKeyId;

  return (
    <div className="mb-6 rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <KeyRound size={16} className="text-muted-foreground" />
        <h2 className="font-semibold">SSH login key</h2>
        {key && <KeyAgeBadge sshKey={key} />}
        {isAdmin && keyAuth && (
          <button
            onClick={() => {
              if (confirm(`Rotate the SSH key of ${server.name}?\n\n${ROTATION_CONFIRM}`)) rotateMutation.mutate();
            }}
            disabled={rotateMutation.isPending}
            className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-muted disabled:opacity-50"
          >
            <RotateCw size={13} className={rotateMutation.isPending ? 'animate-spin' : undefined} />
            {rotateMutation.isPending ? 'Rotating…' : 'Rotate key'}
          </button>
        )}
      </div>
      {server.authType === 'password' ? (
        <p className="text-sm text-muted-foreground">This server uses password authentication, so there is no key to rotate.</p>
      ) : key ? (
        <p className="text-sm">
          <span className="font-medium">{key.name}</span>{' '}
          <span className="text-muted-foreground">
            ({key.type}, created {relativeTime(key.createdAt)})
          </span>{' '}
          <span className="font-mono text-xs text-muted-foreground">{key.fingerprint}</span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">No SSH key assigned.</p>
      )}
      <div className="mt-4">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <History size={12} /> Rotation history
        </p>
        <RotationHistory serverId={serverId} showServer={false} emptyText="This server's key has never been rotated." />
      </div>
    </div>
  );
}
