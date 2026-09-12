import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { useHasRole } from '@/store/auth.js';
import {
  CLOUD_PROVIDER_LABEL,
  CLOUD_PROVIDERS,
  type CloudAccount,
  type CloudProvider,
  type CloudTestResult,
  type CreateCloudAccountRequest,
  type SSHKey,
  type SyncSummary,
  type UpdateCloudAccountRequest,
} from '@smt/shared';
import {
  CircleAlert,
  CircleCheck,
  Cloud,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

interface AccountForm {
  name: string;
  provider: CloudProvider;
  accessKeyId: string;
  secretAccessKey: string;
  token: string;
  /** Comma separated; AWS only. */
  regions: string;
  defaultUsername: string;
  defaultKeyId: string;
  autoImport: boolean;
  syncEnabled: boolean;
}

const empty: AccountForm = {
  name: '',
  provider: 'aws',
  accessKeyId: '',
  secretAccessKey: '',
  token: '',
  regions: '',
  defaultUsername: 'root',
  defaultKeyId: '',
  autoImport: true,
  syncEnabled: true,
};

const PERMISSION_HINT: Record<CloudProvider, string> = {
  aws: 'Needs an IAM user or role with ec2:DescribeInstances and ec2:DescribeRegions. Nothing is ever created or changed in your account.',
  digitalocean: 'Create a personal access token with read scope only (API → Tokens).',
  hetzner: 'Create a read-only API token for the project (Security → API tokens).',
};

const QUERY_KEY = ['cloud-accounts'];

const inputClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

function splitRegions(input: string): string[] {
  return [...new Set(input.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}

function describeSummary(s: SyncSummary): string {
  const parts = [`${s.discovered} discovered`];
  if (s.created) parts.push(`${s.created} new`);
  if (s.updated) parts.push(`${s.updated} updated`);
  if (s.missing) parts.push(`${s.missing} missing`);
  if (s.skipped) parts.push(`${s.skipped} skipped (no IP)`);
  return parts.join(', ');
}

/** Only the credential that matches the provider is sent; blank means "keep" on edit. */
function credentialFields(form: AccountForm): Pick<CreateCloudAccountRequest, 'aws' | 'token'> {
  if (form.provider === 'aws') {
    return form.accessKeyId && form.secretAccessKey
      ? { aws: { accessKeyId: form.accessKeyId, secretAccessKey: form.secretAccessKey } }
      : {};
  }
  return form.token ? { token: form.token } : {};
}

export default function CloudAccountsPage() {
  const qc = useQueryClient();
  const canManage = useHasRole('admin');
  const canSync = useHasRole('operator');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<AccountForm>(empty);

  const { data: accounts, isLoading } = useQuery<CloudAccount[]>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/cloud/accounts'),
  });

  const { data: keys } = useQuery<SSHKey[]>({
    queryKey: ['ssh-keys'],
    queryFn: () => api.get('/keys'),
  });

  const keyName = new Map((keys ?? []).map((k) => [k.id, k.name]));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: QUERY_KEY });
    qc.invalidateQueries({ queryKey: ['servers'] });
  };

  const createMutation = useMutation({
    mutationFn: (body: CreateCloudAccountRequest) => api.post<CloudAccount>('/cloud/accounts', body),
    onSuccess: () => {
      invalidate();
      closeForm();
      toast.success('Account added — the first sync runs within a few seconds');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateCloudAccountRequest }) =>
      api.patch<CloudAccount>(`/cloud/accounts/${id}`, body),
    onSuccess: () => {
      invalidate();
      closeForm();
      toast.success('Account updated');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateCloudAccountRequest }) =>
      api.patch<CloudAccount>(`/cloud/accounts/${id}`, body),
    onSuccess: () => invalidate(),
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/cloud/accounts/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success('Account removed');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => api.post<CloudTestResult>(`/cloud/accounts/${id}/test`),
    onSuccess: (result) => {
      if (result.ok) toast.success(`Credentials OK — ${result.instanceCount ?? 0} instance(s) visible`);
      else toast.error(result.error ?? 'Credential check failed');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const syncMutation = useMutation({
    mutationFn: (id: string) => api.post<SyncSummary>(`/cloud/accounts/${id}/sync`),
    onSuccess: (summary) => {
      invalidate();
      toast.success(`Synced: ${describeSummary(summary)}`);
    },
    onError: (err: Error) => {
      invalidate();
      toast.error(err.message);
    },
  });

  function openCreate() {
    setEditId(null);
    setForm(empty);
    setShowForm(true);
  }

  function openEdit(a: CloudAccount) {
    setEditId(a.id);
    setForm({
      name: a.name,
      provider: a.provider,
      accessKeyId: '',
      secretAccessKey: '',
      token: '',
      regions: a.regions.join(', '),
      defaultUsername: a.defaultUsername,
      defaultKeyId: a.defaultKeyId ?? '',
      autoImport: a.autoImport,
      syncEnabled: a.syncEnabled,
    });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditId(null);
    setForm(empty);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const shared = {
      name: form.name,
      regions: form.provider === 'aws' ? splitRegions(form.regions) : [],
      defaultUsername: form.defaultUsername,
      defaultKeyId: form.defaultKeyId || null,
      autoImport: form.autoImport,
      syncEnabled: form.syncEnabled,
      ...credentialFields(form),
    };
    if (editId) updateMutation.mutate({ id: editId, body: shared });
    else createMutation.mutate({ ...shared, provider: form.provider });
  }

  const busy = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Cloud Accounts</h1>
          <p className="text-muted-foreground text-sm">
            Import and keep servers in sync from AWS EC2, DigitalOcean and Hetzner Cloud
          </p>
        </div>
        {canManage && (
          <button
            onClick={openCreate}
            className="bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium"
          >
            <Plus size={15} /> Add account
          </button>
        )}
      </div>

      {showForm && (
        <div className="border-border bg-card mb-6 rounded-lg border p-5">
          <h2 className="mb-4 font-semibold">{editId ? 'Edit account' : 'New account'}</h2>
          <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Name</label>
              <input
                type="text"
                required
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="Production (AWS)"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Provider</label>
              <select
                value={form.provider}
                disabled={editId !== null}
                onChange={(e) => setForm((p) => ({ ...p, provider: e.target.value as CloudProvider }))}
                className={`${inputClass} disabled:opacity-50`}
              >
                {CLOUD_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {CLOUD_PROVIDER_LABEL[p]}
                  </option>
                ))}
              </select>
            </div>

            {form.provider === 'aws' ? (
              <>
                <div>
                  <label className="mb-1 block text-sm font-medium">Access key ID</label>
                  <input
                    type="text"
                    required={!editId}
                    autoComplete="off"
                    value={form.accessKeyId}
                    onChange={(e) => setForm((p) => ({ ...p, accessKeyId: e.target.value }))}
                    placeholder="AKIA…"
                    className={`${inputClass} font-mono`}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Secret access key</label>
                  <input
                    type="password"
                    required={!editId}
                    autoComplete="new-password"
                    value={form.secretAccessKey}
                    onChange={(e) => setForm((p) => ({ ...p, secretAccessKey: e.target.value }))}
                    className={`${inputClass} font-mono`}
                  />
                </div>
                <div className="col-span-2">
                  <label className="mb-1 block text-sm font-medium">
                    Regions{' '}
                    <span className="text-muted-foreground text-xs">
                      (comma separated — blank scans every enabled region, which is slower)
                    </span>
                  </label>
                  <input
                    type="text"
                    value={form.regions}
                    onChange={(e) => setForm((p) => ({ ...p, regions: e.target.value }))}
                    placeholder="us-east-1, eu-west-1"
                    className={`${inputClass} font-mono`}
                  />
                </div>
              </>
            ) : (
              <div className="col-span-2">
                <label className="mb-1 block text-sm font-medium">API token</label>
                <input
                  type="password"
                  required={!editId}
                  autoComplete="new-password"
                  value={form.token}
                  onChange={(e) => setForm((p) => ({ ...p, token: e.target.value }))}
                  className={`${inputClass} font-mono`}
                />
              </div>
            )}
            <p className="text-muted-foreground col-span-2 -mt-2 text-xs">
              {PERMISSION_HINT[form.provider]}
              {editId ? ' Leave the credential blank to keep the existing one.' : ''}
            </p>

            <div>
              <label className="mb-1 block text-sm font-medium">SSH username for imported servers</label>
              <input
                type="text"
                required
                value={form.defaultUsername}
                onChange={(e) => setForm((p) => ({ ...p, defaultUsername: e.target.value }))}
                placeholder="root / ubuntu / ec2-user"
                className={`${inputClass} font-mono`}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">SSH key for imported servers</label>
              <select
                value={form.defaultKeyId}
                onChange={(e) => setForm((p) => ({ ...p, defaultKeyId: e.target.value }))}
                className={inputClass}
              >
                <option value="">— none —</option>
                {keys?.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} ({k.type})
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.autoImport}
                onChange={(e) => setForm((p) => ({ ...p, autoImport: e.target.checked }))}
                className="border-input size-4 rounded"
              />
              Auto-import new instances as servers
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.syncEnabled}
                onChange={(e) => setForm((p) => ({ ...p, syncEnabled: e.target.checked }))}
                className="border-input size-4 rounded"
              />
              Sync periodically
            </label>

            <div className="col-span-2 flex gap-2">
              <button
                type="submit"
                disabled={busy}
                className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                {busy ? 'Checking credentials…' : editId ? 'Update' : 'Add'}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="border-border hover:bg-muted rounded-md border px-4 py-2 text-sm"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !accounts?.length ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center py-16">
          <Cloud size={40} className="mb-3 opacity-30" />
          <p>
            No cloud accounts yet.
            {canManage ? ' Click "Add account" to import servers from a provider.' : ''}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {accounts.map((a) => (
            <div
              key={a.id}
              className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{a.name}</p>
                  <p className="text-muted-foreground truncate font-mono text-xs">
                    {a.credentialHint}
                    {a.provider === 'aws' && (
                      <> · {a.regions.length ? a.regions.join(', ') : 'all regions'}</>
                    )}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    Imports as <span className="font-mono">{a.defaultUsername}</span>
                    {a.defaultKeyId ? ` with key ${keyName.get(a.defaultKeyId) ?? '…'}` : ' (no key)'}
                    {a.autoImport ? '' : ' · auto-import off'}
                    {a.syncEnabled ? '' : ' · sync paused'}
                  </p>
                </div>
                <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-xs">
                  {CLOUD_PROVIDER_LABEL[a.provider]}
                </span>
              </div>

              {a.lastStatus ? (
                <p
                  className={`flex items-center gap-1 text-xs ${
                    a.lastStatus === 'ok' ? 'text-emerald-500' : 'text-red-500'
                  }`}
                >
                  {a.lastStatus === 'ok' ? <CircleCheck size={11} /> : <CircleAlert size={11} />}
                  {a.lastStatus === 'ok'
                    ? `Synced${a.lastSyncAt ? ` ${new Date(a.lastSyncAt).toLocaleString()}` : ''}${
                        a.lastSummary ? ` · ${describeSummary(a.lastSummary)}` : ''
                      }`
                    : `Sync failed: ${a.lastError ?? 'unknown error'}`}
                </p>
              ) : (
                <p className="text-muted-foreground text-xs">Not synced yet</p>
              )}

              <div className="mt-auto flex flex-wrap gap-2">
                {canSync && (
                  <button
                    onClick={() => syncMutation.mutate(a.id)}
                    disabled={syncMutation.isPending}
                    className="bg-primary/10 text-primary hover:bg-primary/20 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                  >
                    <RefreshCw size={12} className={syncMutation.isPending ? 'animate-spin' : ''} />{' '}
                    Sync now
                  </button>
                )}
                {canManage && (
                  <>
                    <button
                      onClick={() => testMutation.mutate(a.id)}
                      disabled={testMutation.isPending}
                      className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                    >
                      <PlugZap size={12} /> Test
                    </button>
                    <button
                      onClick={() =>
                        toggleMutation.mutate({ id: a.id, body: { syncEnabled: !a.syncEnabled } })
                      }
                      className="text-muted-foreground hover:bg-muted rounded-md px-3 py-1.5 text-xs font-medium"
                    >
                      {a.syncEnabled ? 'Pause' : 'Resume'}
                    </button>
                    <button
                      onClick={() => openEdit(a)}
                      className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium"
                    >
                      <Pencil size={12} /> Edit
                    </button>
                    <button
                      onClick={() => {
                        if (
                          confirm(
                            `Remove account "${a.name}"? Servers imported from it are kept and unlinked.`,
                          )
                        ) {
                          deleteMutation.mutate(a.id);
                        }
                      }}
                      className="ml-auto flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-500/10"
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
