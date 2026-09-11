import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '@/lib/api.js';
import { useHasRole } from '@/store/auth.js';
import type { StorageBucket, StorageConnection, StorageDeleteBucketResponse } from '@smt/shared';
import { ArrowLeft, ArrowRight, FolderOpen, Package, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

const inputClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

interface DeleteDialog {
  bucket: string;
  typed: string;
  force: boolean;
}

export default function StorageBucketsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canManage = useHasRole('admin');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [dialog, setDialog] = useState<DeleteDialog | null>(null);
  const [openName, setOpenName] = useState('');

  const { data: connection } = useQuery<StorageConnection>({
    queryKey: ['storage-connections', id],
    queryFn: () => api.get(`/storage/connections/${id}`),
    enabled: !!id,
  });

  const bucketsQuery = useQuery<StorageBucket[]>({
    queryKey: ['storage-buckets', id],
    queryFn: () => api.get(`/storage/connections/${id}/buckets`),
    enabled: !!id,
    retry: false,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['storage-buckets', id] });

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      api.post<StorageBucket>(`/storage/connections/${id}/buckets`, { name }),
    onSuccess: (bucket) => {
      refresh();
      setShowCreate(false);
      setNewName('');
      toast.success(`Bucket "${bucket.name}" created`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ bucket, force }: { bucket: string; force: boolean }) =>
      api.delete<StorageDeleteBucketResponse>(
        `/storage/connections/${id}/buckets/${encodeURIComponent(bucket)}${force ? '?force=true' : ''}`,
      ),
    onSuccess: (res) => {
      refresh();
      setDialog(null);
      toast.success(
        res.deletedObjects > 0
          ? `Deleted "${res.bucket}" and ${res.deletedObjects} object(s)`
          : `Deleted "${res.bucket}"`,
      );
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function openBucket(name: string) {
    navigate(`/storage/${id}/buckets/${encodeURIComponent(name)}`);
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate('/storage')}
              className="text-muted-foreground hover:text-foreground"
              title="Back to connections"
            >
              <ArrowLeft size={16} />
            </button>
            <h1 className="truncate text-2xl font-bold">{connection?.name ?? 'Buckets'}</h1>
          </div>
          <p className="text-muted-foreground truncate font-mono text-sm">
            {connection ? (connection.endpoint ?? `AWS · ${connection.region}`) : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <button
              onClick={() => setShowCreate(true)}
              className="bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium"
            >
              <Plus size={15} /> New bucket
            </button>
          )}
          <button
            onClick={refresh}
            title="Refresh"
            className="border-border hover:bg-muted rounded-md border p-2"
          >
            <RefreshCw size={15} className={bucketsQuery.isFetching ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {showCreate && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createMutation.mutate(newName.trim());
          }}
          className="border-border bg-card mb-6 flex items-end gap-2 rounded-lg border p-4"
        >
          <div className="flex-1">
            <label className="mb-1 block text-sm font-medium">Bucket name</label>
            <input
              type="text"
              required
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="my-backups"
              pattern="[a-z0-9.-]{3,63}"
              title="3–63 lowercase letters, digits, dots or hyphens"
              className={`${inputClass} font-mono`}
            />
          </div>
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            Create
          </button>
          <button
            type="button"
            onClick={() => {
              setShowCreate(false);
              setNewName('');
            }}
            className="border-border hover:bg-muted rounded-md border px-4 py-2 text-sm"
          >
            Cancel
          </button>
        </form>
      )}

      {/* A key allowed into one bucket but not to list them all still needs a way in */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (openName.trim()) openBucket(openName.trim());
        }}
        className="mb-4 flex items-center gap-2"
      >
        <input
          type="text"
          value={openName}
          onChange={(e) => setOpenName(e.target.value)}
          placeholder="Open a bucket by name…"
          className="border-input bg-background focus:ring-primary w-72 rounded-md border px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2"
        />
        <button
          type="submit"
          disabled={!openName.trim()}
          title="Open bucket"
          className="border-border hover:bg-muted flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm disabled:opacity-40"
        >
          Open <ArrowRight size={13} />
        </button>
      </form>

      {bucketsQuery.isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : bucketsQuery.isError ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">
          {(bucketsQuery.error as Error).message}
        </div>
      ) : bucketsQuery.data?.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center py-16">
          <Package size={40} className="mb-3 opacity-30" />
          <p>No buckets visible to this key.{canManage ? ' Create one to get started.' : ''}</p>
        </div>
      ) : (
        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="border-border text-muted-foreground border-b text-left">
              <tr>
                <th className="px-4 py-2 font-medium">Bucket</th>
                <th className="w-48 px-4 py-2 font-medium">Created</th>
                <th className="w-32 px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {bucketsQuery.data?.map((b) => (
                <tr key={b.name} className="border-border hover:bg-muted/40 border-b last:border-0">
                  <td className="px-4 py-2">
                    <button
                      onClick={() => openBucket(b.name)}
                      className="flex items-center gap-2 text-left hover:underline"
                    >
                      <Package size={15} className="text-primary" />
                      <span className="font-mono">{b.name}</span>
                    </button>
                  </td>
                  <td className="text-muted-foreground px-4 py-2">
                    {b.createdAt ? new Date(b.createdAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => openBucket(b.name)}
                        title="Browse"
                        className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md p-1.5"
                      >
                        <FolderOpen size={13} />
                      </button>
                      {canManage && (
                        <button
                          onClick={() => setDialog({ bucket: b.name, typed: '', force: false })}
                          title="Delete bucket"
                          className="rounded-md p-1.5 text-red-500 hover:bg-red-500/10"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
          <div className="border-border bg-card w-full max-w-md rounded-lg border p-5 shadow-xl">
            <h2 className="mb-1 font-semibold">Delete bucket</h2>
            <p className="text-muted-foreground mb-4 text-sm">
              This cannot be undone. Type <span className="font-mono">{dialog.bucket}</span> to
              confirm.
            </p>
            <input
              type="text"
              autoFocus
              value={dialog.typed}
              onChange={(e) => setDialog({ ...dialog, typed: e.target.value })}
              className={`${inputClass} mb-3 font-mono`}
            />
            <label className="mb-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={dialog.force}
                onChange={(e) => setDialog({ ...dialog, force: e.target.checked })}
                className="border-input size-4 rounded"
              />
              Also delete every object inside it
            </label>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDialog(null)}
                className="border-border hover:bg-muted rounded-md border px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  deleteMutation.mutate({ bucket: dialog.bucket, force: dialog.force })
                }
                disabled={dialog.typed !== dialog.bucket || deleteMutation.isPending}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete bucket'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
