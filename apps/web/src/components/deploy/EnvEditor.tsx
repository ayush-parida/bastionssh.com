import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEPLOY_ENV_KEY_PATTERN, type DeployEnvKeys, type DeployEnvReveal } from '@smt/shared';
import { Eye, EyeOff, KeyRound, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api.js';
import { appPath, deployKeys } from '@/lib/deploy.js';
import { passkeyErrorMessage, withStepUp } from '@/lib/passkeys.js';
import ConfirmDialog from '@/components/docker/ConfirmDialog.js';

const input = 'w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary';

/** Set a value: the field is write-only, and empty until typed into. */
function ValueForm({ label, busy, onSubmit, onCancel }: { label: string; busy: boolean; onSubmit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <input
        type="password"
        autoComplete="off"
        autoFocus
        aria-label={label}
        placeholder="New value"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={`${input} font-mono`}
      />
      <button type="submit" disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
        {busy ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
      </button>
      <button type="button" onClick={onCancel} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
        Cancel
      </button>
    </form>
  );
}

/**
 * The app's `.env` on the server (spec §7): variable names are listed, values
 * are write-only. Revealing one needs a passkey confirmation and is recorded
 * in the audit log (by name); it shows only until hidden or the app changes.
 * A container gets `.env` when it is created — by a deploy or a rollback; a
 * restart keeps the environment it was created with — so a change applies
 * on the next deploy.
 */
export default function EnvEditor({ serverId, app }: { serverId: string; app: string }) {
  const qc = useQueryClient();
  const keys = useQuery<DeployEnvKeys>({
    queryKey: deployKeys.env(serverId, app),
    queryFn: () => api.get(appPath(serverId, app, '/env')),
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Revealed values never carry over to another app
  useEffect(() => {
    setRevealed({});
    setEditing(null);
    setError(null);
  }, [serverId, app]);

  const set = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      api.put<{ key: string; changed: boolean }>(appPath(serverId, app, `/env/${encodeURIComponent(key)}`), { value }),
    onSuccess: (res) => {
      toast.success(res.changed ? `${res.key} saved — deploy again to apply` : `${res.key} unchanged`);
      setEditing(null);
      setAdding(false);
      setNewKey('');
      setNewValue('');
      setRevealed(({ [res.key]: _dropped, ...rest }) => rest);
      qc.invalidateQueries({ queryKey: deployKeys.env(serverId, app) });
    },
    onError: (err: Error) => setError(err.message),
  });

  async function reveal(key: string) {
    setRevealing(key);
    setError(null);
    try {
      const res = await withStepUp(() => api.post<DeployEnvReveal>(appPath(serverId, app, `/env/${encodeURIComponent(key)}/reveal`)));
      setRevealed((r) => ({ ...r, [key]: res.value }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : passkeyErrorMessage(err, 'Could not reveal the value'));
    } finally {
      setRevealing(null);
    }
  }

  const keyValid = DEPLOY_ENV_KEY_PATTERN.test(newKey);
  const exists = keys.data?.keys.includes(newKey);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm text-muted-foreground">
          Values are never shown here unless revealed; revealing one asks for your passkey and is recorded in the audit log. Changes apply when the app
          is next deployed (a restart keeps the values it started with).
        </p>
        {!adding && (
          <button onClick={() => setAdding(true)} className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm hover:bg-muted">
            <Plus size={14} /> Add variable
          </button>
        )}
      </div>

      {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}

      {adding && (
        <form
          aria-label="Add variable"
          className="space-y-2 rounded-md border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (keyValid) set.mutate({ key: newKey, value: newValue });
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              aria-label="Variable name"
              placeholder="DATABASE_URL"
              autoFocus
              value={newKey}
              onChange={(e) => setNewKey(e.target.value.trim())}
              className={`${input} font-mono`}
            />
            <input
              type="password"
              autoComplete="off"
              aria-label="Variable value"
              placeholder="Value"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              className={`${input} font-mono`}
            />
          </div>
          {newKey && !keyValid && <p className="text-xs text-red-600">Letters, digits and _, not starting with a digit</p>}
          {exists && <p className="text-xs text-amber-600">{newKey} exists; saving replaces its value.</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                // A typed value is not kept for the next variable added
                setAdding(false);
                setNewKey('');
                setNewValue('');
              }}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
              Cancel
            </button>
            <button type="submit" disabled={!keyValid || set.isPending} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
              Add
            </button>
          </div>
        </form>
      )}

      {keys.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : keys.error ? (
        <p className="text-sm text-red-600">{(keys.error as Error).message}</p>
      ) : keys.data?.keys.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">No variables in .env.</p>
      ) : (
        <ul aria-label="Variables" className="divide-y divide-border rounded-md border border-border">
          {keys.data?.keys.map((key) => (
            <li key={key} aria-label={key} className="space-y-2 px-3 py-2">
              <div className="flex items-center gap-2">
                <KeyRound size={13} className="shrink-0 text-muted-foreground" />
                <span className="font-mono text-sm">{key}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {key in revealed ? (
                    <span className="select-all rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-800 dark:text-amber-200">{revealed[key] || '(empty)'}</span>
                  ) : (
                    <span className="text-muted-foreground">••••••••</span>
                  )}
                </span>
                {key in revealed ? (
                  <button
                    onClick={() => setRevealed(({ [key]: _dropped, ...rest }) => rest)}
                    title="Hide the value"
                    aria-label={`Hide ${key}`}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <EyeOff size={14} />
                  </button>
                ) : (
                  <button
                    onClick={() => void reveal(key)}
                    disabled={revealing !== null}
                    title="Show the value. Needs a passkey confirmation, and is recorded in the audit log."
                    aria-label={`Reveal ${key}`}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    {revealing === key ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
                  </button>
                )}
                <button
                  onClick={() => setEditing(editing === key ? null : key)}
                  title="Set a new value"
                  aria-label={`Change ${key}`}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => setRemoving(key)}
                  title="Remove"
                  aria-label={`Remove ${key}`}
                  className="rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-600"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {editing === key && (
                <ValueForm label={`New value for ${key}`} busy={set.isPending} onSubmit={(value) => set.mutate({ key, value })} onCancel={() => setEditing(null)} />
              )}
            </li>
          ))}
        </ul>
      )}

      {removing && (
        <ConfirmDialog
          title="Remove variable"
          subject={removing}
          confirmLabel="Remove"
          onConfirm={async () => {
            await api.delete(appPath(serverId, app, `/env/${encodeURIComponent(removing)}`));
            toast.success(`${removing} removed — deploy again to apply`);
            setRevealed(({ [removing]: _dropped, ...rest }) => rest);
            await qc.invalidateQueries({ queryKey: deployKeys.env(serverId, app) });
          }}
          onClose={() => setRemoving(null)}
        >
          <p>The app keeps the old value until it is deployed again (a restart keeps it).</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
