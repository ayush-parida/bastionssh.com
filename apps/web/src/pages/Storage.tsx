import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api.js';
import { useHasRole } from '@/store/auth.js';
import type {
  CreateStorageConnectionRequest,
  StorageConnection,
  StorageProvider,
  StorageTestResult,
  UpdateStorageConnectionRequest,
} from '@smt/shared';
import {
  CircleAlert,
  CircleCheck,
  FolderOpen,
  HardDrive,
  Pencil,
  PlugZap,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

interface ConnectionForm {
  name: string;
  provider: StorageProvider;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

const empty: ConnectionForm = {
  name: '',
  provider: 'minio',
  endpoint: '',
  region: 'us-east-1',
  accessKeyId: '',
  secretAccessKey: '',
  forcePathStyle: true,
};

const PROVIDER_LABEL: Record<StorageProvider, string> = {
  s3: 'AWS S3',
  minio: 'MinIO',
  other: 'S3-compatible',
};

const QUERY_KEY = ['storage-connections'];

const inputClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

function describeTarget(c: StorageConnection): string {
  return c.endpoint ? `${c.endpoint} · ${c.region}` : `AWS · ${c.region}`;
}

export default function StoragePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canManage = useHasRole('admin');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<ConnectionForm>(empty);

  const { data: connections, isLoading } = useQuery<StorageConnection[]>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/storage/connections'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: QUERY_KEY });

  const createMutation = useMutation({
    mutationFn: (body: CreateStorageConnectionRequest) =>
      api.post<StorageConnection>('/storage/connections', body),
    onSuccess: () => {
      invalidate();
      closeForm();
      toast.success('Connection added');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateStorageConnectionRequest }) =>
      api.patch<StorageConnection>(`/storage/connections/${id}`, body),
    onSuccess: () => {
      invalidate();
      closeForm();
      toast.success('Connection updated');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/storage/connections/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success('Connection removed');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => api.post<StorageTestResult>(`/storage/connections/${id}/test`),
    onSuccess: (result) => {
      invalidate();
      if (result.ok) toast.success(`Connected — ${result.bucketCount ?? 0} bucket(s) visible`);
      else toast.error(result.error ?? 'Connection failed');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function openCreate() {
    setEditId(null);
    setForm(empty);
    setShowForm(true);
  }

  function openEdit(c: StorageConnection) {
    setEditId(c.id);
    setForm({
      name: c.name,
      provider: c.provider,
      endpoint: c.endpoint ?? '',
      region: c.region,
      accessKeyId: c.accessKeyId,
      secretAccessKey: '',
      forcePathStyle: c.forcePathStyle,
    });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditId(null);
    setForm(empty);
  }

  function setProvider(provider: StorageProvider) {
    // AWS prefers virtual-host addressing; everyone else usually needs path style
    setForm((p) => ({ ...p, provider, forcePathStyle: provider !== 's3' }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const endpoint = form.endpoint.trim() || null;
    if (editId) {
      updateMutation.mutate({
        id: editId,
        body: {
          name: form.name,
          provider: form.provider,
          endpoint,
          region: form.region,
          accessKeyId: form.accessKeyId,
          // Blank means "keep the stored secret" — it is never sent back to the client
          ...(form.secretAccessKey ? { secretAccessKey: form.secretAccessKey } : {}),
          forcePathStyle: form.forcePathStyle,
        },
      });
    } else {
      createMutation.mutate({
        name: form.name,
        provider: form.provider,
        endpoint,
        region: form.region,
        accessKeyId: form.accessKeyId,
        secretAccessKey: form.secretAccessKey,
        forcePathStyle: form.forcePathStyle,
      });
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Object Storage</h1>
          <p className="text-muted-foreground text-sm">Browse and manage S3 and MinIO buckets</p>
        </div>
        {canManage && (
          <button
            onClick={openCreate}
            className="bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium"
          >
            <Plus size={15} /> Add connection
          </button>
        )}
      </div>

      {showForm && (
        <div className="border-border bg-card mb-6 rounded-lg border p-5">
          <h2 className="mb-4 font-semibold">{editId ? 'Edit connection' : 'New connection'}</h2>
          <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Name</label>
              <input
                type="text"
                required
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="Backups (MinIO)"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Provider</label>
              <select
                value={form.provider}
                onChange={(e) => setProvider(e.target.value as StorageProvider)}
                className={inputClass}
              >
                <option value="minio">MinIO</option>
                <option value="s3">AWS S3</option>
                <option value="other">Other S3-compatible (Wasabi, R2, Spaces, Ceph…)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                Endpoint{' '}
                {form.provider === 's3' && (
                  <span className="text-muted-foreground text-xs">(optional — blank uses AWS)</span>
                )}
              </label>
              <input
                type="url"
                required={form.provider !== 's3'}
                value={form.endpoint}
                onChange={(e) => setForm((p) => ({ ...p, endpoint: e.target.value }))}
                placeholder={
                  form.provider === 's3' ? 'https://s3.amazonaws.com' : 'http://minio.internal:9000'
                }
                className={`${inputClass} font-mono`}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Region</label>
              <input
                type="text"
                required
                value={form.region}
                onChange={(e) => setForm((p) => ({ ...p, region: e.target.value }))}
                placeholder="us-east-1"
                className={`${inputClass} font-mono`}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Access key ID</label>
              <input
                type="text"
                required
                autoComplete="off"
                value={form.accessKeyId}
                onChange={(e) => setForm((p) => ({ ...p, accessKeyId: e.target.value }))}
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
              {editId && (
                <p className="text-muted-foreground mt-1 text-xs">
                  Leave blank to keep the existing secret.
                </p>
              )}
            </div>
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.forcePathStyle}
                onChange={(e) => setForm((p) => ({ ...p, forcePathStyle: e.target.checked }))}
                className="border-input size-4 rounded"
              />
              Path-style addressing
              <span className="text-muted-foreground text-xs">
                (host/bucket/key — required by MinIO; AWS uses bucket.host)
              </span>
            </label>
            <div className="col-span-2 flex gap-2">
              <button
                type="submit"
                disabled={createMutation.isPending || updateMutation.isPending}
                className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                {editId ? 'Update' : 'Add'}
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
      ) : !connections?.length ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center py-16">
          <HardDrive size={40} className="mb-3 opacity-30" />
          <p>
            No storage connections yet.
            {canManage ? ' Click "Add connection" to register an S3 or MinIO endpoint.' : ''}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {connections.map((c) => (
            <div
              key={c.id}
              className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{c.name}</p>
                  <p className="text-muted-foreground truncate font-mono text-sm">
                    {describeTarget(c)}
                  </p>
                  <p className="text-muted-foreground truncate font-mono text-xs">
                    {c.accessKeyId}
                  </p>
                </div>
                <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-xs">
                  {PROVIDER_LABEL[c.provider]}
                </span>
              </div>
              {c.lastStatus && (
                <p
                  className={`flex items-center gap-1 text-xs ${
                    c.lastStatus === 'ok' ? 'text-emerald-500' : 'text-red-500'
                  }`}
                >
                  {c.lastStatus === 'ok' ? <CircleCheck size={11} /> : <CircleAlert size={11} />}
                  {c.lastStatus === 'ok'
                    ? `Connected${c.lastTestedAt ? ` · ${new Date(c.lastTestedAt).toLocaleString()}` : ''}`
                    : `Failed: ${c.lastError ?? 'unknown error'}`}
                </p>
              )}
              <div className="mt-auto flex gap-2">
                <button
                  onClick={() => navigate(`/storage/${c.id}`)}
                  className="bg-primary/10 text-primary hover:bg-primary/20 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium"
                >
                  <FolderOpen size={12} /> Browse
                </button>
                {canManage && (
                  <>
                    <button
                      onClick={() => testMutation.mutate(c.id)}
                      disabled={testMutation.isPending}
                      className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                    >
                      <PlugZap size={12} /> Test
                    </button>
                    <button
                      onClick={() => openEdit(c)}
                      className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium"
                    >
                      <Pencil size={12} /> Edit
                    </button>
                    <button
                      onClick={() => {
                        if (
                          confirm(
                            `Remove connection "${c.name}"? Buckets and objects are not touched.`,
                          )
                        ) {
                          deleteMutation.mutate(c.id);
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
