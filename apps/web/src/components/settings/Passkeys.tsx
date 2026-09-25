import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api } from '@/lib/api.js';
import { relativeTime } from '@/lib/utils.js';
import {
  insecureContext,
  isPasskeyCancel,
  isReauthRequired,
  passkeyErrorMessage,
  registerPasskey,
  withStepUp,
} from '@/lib/passkeys.js';
import { useAuthStore } from '@/store/auth.js';
import type { PasskeyInfo } from '@smt/shared';
import { Fingerprint, Pencil, Plus, Trash2, Check, X } from 'lucide-react';
import { toast } from 'sonner';

/** Toast a failed passkey action, unless the user simply dismissed the prompt. */
function reportError(err: Error) {
  if (!isPasskeyCancel(err)) toast.error(passkeyErrorMessage(err));
}

export default function Passkeys() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const clearUser = useAuthStore((s) => s.clearUser);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [password, setPassword] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const supported = !insecureContext && browserSupportsWebAuthn();

  const { data: passkeys } = useQuery<PasskeyInfo[]>({
    queryKey: ['passkeys'],
    queryFn: () => api.get('/auth/passkeys'),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['passkeys'] });
    qc.invalidateQueries({ queryKey: ['auth-me'] });
  };

  // A first passkey needs the password and a recent sign-in; later ones need
  // this session to confirm an existing passkey
  const first = passkeys?.length === 0;
  const addMutation = useMutation({
    mutationFn: (name: string) =>
      withStepUp(() => registerPasskey(name.trim() || undefined, first ? password : undefined)),
    onSuccess: () => {
      refresh();
      setAdding(false);
      setNewName('');
      setPassword('');
      toast.success('Passkey added');
    },
    onError: async (err: Error) => {
      if (!isReauthRequired(err)) return reportError(err);
      toast.message('Sign in again, then add your first passkey within 15 minutes.');
      await api.post('/auth/logout').catch(() => {});
      clearUser();
      qc.clear();
      navigate('/login');
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.patch(`/auth/passkeys/${id}`, { name }),
    onSuccess: () => { refresh(); setEditing(null); toast.success('Passkey renamed'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => withStepUp(() => api.delete(`/auth/passkeys/${id}`)),
    onSuccess: () => { refresh(); toast.success('Passkey removed'); },
    onError: reportError,
  });

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold">Passkeys</h2>
        {supported && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus size={14} /> Add passkey
          </button>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Sign in with your fingerprint, face or device PIN instead of a password. Once you have a passkey,
        signing in with your password also asks for it.
      </p>

      {!supported && (
        <p className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
          {insecureContext
            ? 'Passkeys need this page to be served over HTTPS (or from localhost).'
            : 'This browser does not support passkeys.'}
        </p>
      )}

      {adding && (
        <form
          onSubmit={(e) => { e.preventDefault(); addMutation.mutate(newName); }}
          className="mb-4 flex items-end gap-2 rounded-lg border border-border bg-card p-4"
        >
          <div className="flex-1">
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              type="text"
              maxLength={100}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. MacBook Touch ID, YubiKey"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          {first && (
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">Your password</label>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          )}
          <button
            type="submit"
            disabled={addMutation.isPending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {addMutation.isPending ? 'Waiting for device…' : 'Create'}
          </button>
          <button type="button" onClick={() => setAdding(false)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
            Cancel
          </button>
        </form>
      )}

      <div className="rounded-lg border border-border bg-card divide-y divide-border">
        {!passkeys?.length ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No passkeys yet.</p>
        ) : (
          passkeys.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-4 py-3">
              <Fingerprint size={16} className="text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                {editing?.id === p.id ? (
                  <form
                    onSubmit={(e) => { e.preventDefault(); if (editing.name.trim()) renameMutation.mutate(editing); }}
                    className="flex items-center gap-2"
                  >
                    <input
                      autoFocus
                      maxLength={100}
                      value={editing.name}
                      onChange={(e) => setEditing({ id: p.id, name: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}
                      className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                    <button type="submit" className="text-muted-foreground hover:text-foreground" title="Save">
                      <Check size={14} />
                    </button>
                    <button type="button" onClick={() => setEditing(null)} className="text-muted-foreground hover:text-foreground" title="Cancel">
                      <X size={14} />
                    </button>
                  </form>
                ) : (
                  <p className="text-sm font-medium truncate">{p.name}</p>
                )}
                <p className="text-xs text-muted-foreground truncate">
                  {p.backedUp ? 'Synced' : 'This device only'}
                  {' · '}added {relativeTime(p.createdAt)}
                  {' · '}
                  {p.lastUsedAt ? `last used ${relativeTime(p.lastUsedAt)}` : 'never used'}
                </p>
              </div>
              {editing?.id !== p.id && (
                <>
                  <button
                    onClick={() => setEditing({ id: p.id, name: p.name })}
                    className="text-muted-foreground hover:text-foreground mr-1"
                    title="Rename"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => { if (confirm(`Remove the passkey "${p.name}"?`)) deleteMutation.mutate(p.id); }}
                    className="text-red-500 hover:text-red-600"
                    title="Remove"
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
