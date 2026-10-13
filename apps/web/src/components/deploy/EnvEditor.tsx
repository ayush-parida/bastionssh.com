import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEPLOY_ENV_KEY_PATTERN, type DeployEnvFile, type DeployEnvKeys, type DeployEnvReplaced, type DeployEnvReveal, type DeployEnvTextIssue } from '@smt/shared';
import { Eye, EyeOff, FileText, KeyRound, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
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

const names = (keys: string[]) => keys.join(', ');

/** The names `.env` text sets: `KEY=` lines, the way bastionctl reads them. */
function envNames(text: string): string[] {
  return [...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]!);
}

/** What a save changed, by name: "Added A; changed B; removed C". */
function summary({ added, changed, removed }: DeployEnvReplaced): string {
  const parts = [
    added.length > 0 && `added ${names(added)}`,
    changed.length > 0 && `changed ${names(changed)}`,
    removed.length > 0 && `removed ${names(removed)}`,
  ].filter(Boolean);
  return parts.length === 0 ? 'No variables changed' : `${parts.join('; ')}`.replace(/^./, (c) => c.toUpperCase());
}

/**
 * `.env` as one text file: loaded after a passkey confirmation (like a
 * reveal), saved whole. The server checks every line and refuses a save when
 * the file changed after it was opened.
 */
function EnvTextEditor({ serverId, app, file, onDone, onReload }: { serverId: string; app: string; file: DeployEnvFile; onDone: () => void; onReload: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState(file.text);
  const [issues, setIssues] = useState<DeployEnvTextIssue[]>([]);
  const [error, setError] = useState<{ message: string; stale: boolean } | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const dirty = text !== file.text;
  // Saving text with no variables left removes every one the file has: confirm that first
  const removesAll = envNames(text).length === 0 ? [...new Set(envNames(file.text))] : [];

  const save = useMutation({
    mutationFn: () => api.put<DeployEnvReplaced>(appPath(serverId, app, '/env-file'), { text, sha256: file.sha256 }),
    onSuccess: (res) => {
      toast.success(`${summary(res)} — restart the app to apply`);
      qc.invalidateQueries({ queryKey: deployKeys.env(serverId, app) });
      onDone();
    },
    onError: (err: Error) => {
      if (err instanceof ApiError && err.code === 'env_invalid') {
        setIssues((err.details?.issues as DeployEnvTextIssue[] | undefined) ?? []);
        setError(null);
        return;
      }
      setIssues([]);
      setError({ message: err.message, stale: err instanceof ApiError && err.code === 'env_changed' });
    },
  });

  return (
    <>
    <form
      aria-label="Edit .env as text"
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (removesAll.length > 0) setConfirmEmpty(true);
        else save.mutate();
      }}
    >
      <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
        Values are visible while you edit. One <code>KEY=value</code> per line; <code>#</code> starts a comment. Quote values with spaces or <code>#</code> in
        them (<code>"…"</code>). Saving replaces the whole file; changes apply when the app is next restarted or deployed.
      </p>
      {error && (
        <div className="flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">
          <span className="flex-1">{error.message}</span>
          {error.stale && (
            <button type="button" onClick={onReload} className="rounded-md border border-red-500/30 px-2 py-0.5 text-xs hover:bg-red-500/10">
              Open again
            </button>
          )}
        </div>
      )}
      {issues.length > 0 && (
        <ul aria-label="Problems" className="space-y-0.5 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">
          {issues.map((i) => (
            <li key={`${i.line}-${i.message}`}>{i.line > 0 ? `Line ${i.line}: ${i.message}` : i.message}</li>
          ))}
        </ul>
      )}
      <textarea
        aria-label=".env"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        autoFocus
        rows={Math.min(30, Math.max(8, text.split('\n').length + 2))}
        placeholder={'DATABASE_URL="postgres://…"\nNODE_ENV=production'}
        className={`${input} resize-y font-mono text-xs leading-5`}
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
          {dirty ? 'Discard' : 'Close'}
        </button>
        <button type="submit" disabled={!dirty || save.isPending} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
          {save.isPending ? <Loader2 size={14} className="animate-spin" /> : 'Save .env'}
        </button>
      </div>
    </form>
    {confirmEmpty && (
      <ConfirmDialog
        title="Save an empty .env"
        subject={app}
        confirmLabel={removesAll.length === 1 ? 'Remove the variable' : `Remove all ${removesAll.length} variables`}
        onConfirm={() => save.mutateAsync().catch(() => undefined)}
        onClose={() => setConfirmEmpty(false)}
      >
        <p>
          The text has no variables left, so saving removes {removesAll.length === 1 ? 'the only one' : `all ${removesAll.length}`} from the app's .env:{' '}
          <span className="font-mono">{names(removesAll)}</span>.
        </p>
        <p className="mt-2">The app keeps its current values until it is restarted or deployed again.</p>
      </ConfirmDialog>
    )}
    </>
  );
}

/**
 * The app's `.env` on the server (spec §7): variable names are listed, values
 * are write-only. Revealing one needs a passkey confirmation and is recorded
 * in the audit log (by name); it shows only until hidden or the app changes.
 * A container gets `.env` when it is created — by a deploy, a rollback or a
 * restart (which starts a fresh container of the current release) — so a
 * change applies on the next restart, without a rebuild.
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
  const [file, setFile] = useState<DeployEnvFile | null>(null);
  const [opening, setOpening] = useState(false);

  // Revealed values never carry over to another app
  useEffect(() => {
    setRevealed({});
    setEditing(null);
    setError(null);
    setFile(null);
  }, [serverId, app]);

  async function openAsText() {
    setOpening(true);
    setError(null);
    try {
      const res = await withStepUp(() => api.post<DeployEnvFile>(appPath(serverId, app, '/env-file/reveal')));
      setRevealed({});
      setAdding(false);
      setEditing(null);
      setFile(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : passkeyErrorMessage(err, 'Could not open .env'));
    } finally {
      setOpening(false);
    }
  }

  const set = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      api.put<{ key: string; changed: boolean }>(appPath(serverId, app, `/env/${encodeURIComponent(key)}`), { value }),
    onSuccess: (res) => {
      toast.success(res.changed ? `${res.key} saved — restart the app to apply` : `${res.key} unchanged`);
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
          is next restarted or deployed (a restart needs no rebuild).
        </p>
        {!file && (
          <button
            onClick={() => void openAsText()}
            disabled={opening}
            title="Edit every variable as one text file. Needs a passkey confirmation, and is recorded in the audit log."
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm hover:bg-muted disabled:opacity-50"
          >
            {opening ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />} Edit as text
          </button>
        )}
        {!adding && !file && (
          <button onClick={() => setAdding(true)} className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm hover:bg-muted">
            <Plus size={14} /> Add variable
          </button>
        )}
      </div>

      {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}

      {file && (
        <EnvTextEditor
          key={file.sha256}
          serverId={serverId}
          app={app}
          file={file}
          onDone={() => setFile(null)}
          onReload={() => {
            setFile(null);
            void openAsText();
          }}
        />
      )}

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

      {file ? null : keys.isLoading ? (
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
            toast.success(`${removing} removed — restart the app to apply`);
            setRevealed(({ [removing]: _dropped, ...rest }) => rest);
            await qc.invalidateQueries({ queryKey: deployKeys.env(serverId, app) });
          }}
          onClose={() => setRemoving(null)}
        >
          <p>The app keeps the old value until it is restarted or deployed again.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
