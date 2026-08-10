import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import type { ApiToken, CreatedApiToken, TokenScope } from '@smt/shared';
import { Plus, Trash2, Terminal, Copy, X, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

const QUERY_KEY = ['api-tokens'];

const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: '', label: 'Never' },
];

export default function ApiTokens() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [writable, setWritable] = useState(false);
  const [expiresIn, setExpiresIn] = useState('90');
  const [created, setCreated] = useState<CreatedApiToken | null>(null);

  const { data: tokens } = useQuery<ApiToken[]>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/tokens'),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<CreatedApiToken>('/tokens', {
        name,
        scopes: (writable ? ['read', 'write'] : ['read']) as TokenScope[],
        ...(expiresIn ? { expiresInDays: Number(expiresIn) } : {}),
      }),
    onSuccess: async (token) => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      setShowForm(false);
      setName('');
      setCreated(token);
      await copy(token.token, 'Token created — copied to clipboard');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/tokens/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEY }); toast.success('Token revoked'); },
    onError: (err: Error) => toast.error(err.message),
  });

  async function copy(value: string, message = 'Copied') {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(message);
    } catch {
      toast.message('Copy the token below', { duration: 10_000 });
    }
  }

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold">API tokens</h2>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus size={14} /> New token
        </button>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Call the API from scripts and CI with <code className="font-mono text-xs">Authorization: Bearer …</code> instead of signing in.
      </p>

      {created && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="flex items-start gap-2">
            <TriangleAlert size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                Copy this token now — it won't be shown again
              </p>
              <p className="text-xs text-muted-foreground mb-2">
                Only a hash is stored. If you lose it, revoke the token and create another.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate rounded bg-background px-2 py-1.5 text-xs font-mono">
                  {created.token}
                </code>
                <button
                  onClick={() => copy(created.token)}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs hover:bg-muted"
                >
                  <Copy size={12} /> Copy
                </button>
              </div>
            </div>
            <button onClick={() => setCreated(null)} className="text-muted-foreground hover:text-foreground">
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <div className="mb-4 rounded-lg border border-border bg-card p-5">
          <h3 className="text-sm font-semibold mb-3">New token</h3>
          <form
            onSubmit={(e) => { e.preventDefault(); createMutation.mutate(); }}
            className="space-y-3"
          >
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="deploy-pipeline"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Expires</label>
                <select
                  value={expiresIn}
                  onChange={(e) => setExpiresIn(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  {EXPIRY_OPTIONS.map((o) => <option key={o.label} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={writable}
                onChange={(e) => setWritable(e.target.checked)}
                className="size-4 rounded border-input"
              />
              Allow writes
            </label>
            <p className="text-xs text-muted-foreground">
              Read-only tokens act as a viewer no matter your role. A write token can do anything you
              can — never more.
            </p>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={createMutation.isPending}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {createMutation.isPending ? 'Creating…' : 'Create token'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {!tokens?.length ? (
          <div className="flex flex-col items-center py-12 text-muted-foreground">
            <Terminal size={36} className="mb-3 opacity-30" />
            <p className="text-sm">No API tokens yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {tokens.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium flex items-center gap-2">
                    {t.name}
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {t.scopes.includes('write') ? 'read/write' : 'read-only'}
                    </span>
                    {t.expired && <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-xs text-red-500">Expired</span>}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    <span className="font-mono">smt_{t.prefix}…</span>
                    {' · '}
                    {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : 'never used'}
                    {t.expiresAt ? ` · expires ${new Date(t.expiresAt).toLocaleDateString()}` : ' · no expiry'}
                  </p>
                </div>
                <button
                  onClick={() => { if (confirm(`Revoke ${t.name}? Anything using it stops working immediately.`)) revokeMutation.mutate(t.id); }}
                  className="text-red-500 hover:text-red-600"
                  title="Revoke"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
