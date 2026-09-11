import { useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '@/lib/api.js';
import { useHasRole } from '@/store/auth.js';
import { formatBytes } from '@/lib/utils.js';
import type {
  StorageFolder,
  StorageListResponse,
  StorageObject,
  StorageUploadResponse,
} from '@smt/shared';
import {
  ArrowLeft,
  ArrowUp,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';

/**
 * Above this size the browser downloads by navigating to the object URL — the
 * route sends `Content-Disposition: attachment`, so it streams to disk without
 * leaving the page. Smaller objects go through fetch so failures become toasts
 * instead of a JSON error page.
 */
const STREAM_DOWNLOAD_BYTES = 256 * 1024 * 1024;

export default function StorageObjectsPage() {
  const { id, bucket } = useParams<{ id: string; bucket: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [prefix, setPrefix] = useState('');
  // One upload can finish while another is still going, so count rather than flag
  const [uploadsInFlight, setUploadsInFlight] = useState(0);

  // Server enforces these too — this only keeps unusable controls off the screen
  const canWrite = useHasRole('operator');

  const base = `/storage/connections/${id}/buckets/${encodeURIComponent(bucket ?? '')}`;

  const listQuery = useInfiniteQuery({
    queryKey: ['storage-objects', id, bucket, prefix],
    queryFn: ({ pageParam }): Promise<StorageListResponse> =>
      api.get(
        `${base}/objects?prefix=${encodeURIComponent(prefix)}${
          pageParam ? `&token=${encodeURIComponent(pageParam)}` : ''
        }`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextToken ?? undefined,
    enabled: !!id && !!bucket,
    retry: false,
  });

  const pages = listQuery.data?.pages ?? [];
  const folders = pages.flatMap((p) => p.folders);
  const objects = pages.flatMap((p) => p.objects);
  const parent = pages[0]?.parent ?? null;

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['storage-objects', id, bucket] });
  }

  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      api.upload<StorageUploadResponse>(
        `${base}/object?key=${encodeURIComponent(prefix + file.name)}${
          file.type ? `&contentType=${encodeURIComponent(file.type)}` : ''
        }`,
        file,
      ),
    onMutate: () => setUploadsInFlight((n) => n + 1),
    onSettled: () => setUploadsInFlight((n) => n - 1),
    onSuccess: (_res, file) => {
      refresh();
      toast.success(`Uploaded ${file.name}`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const mkdirMutation = useMutation({
    mutationFn: (target: string) => api.post(`${base}/folder`, { prefix: target }),
    onSuccess: () => {
      refresh();
      toast.success('Folder created');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const renameMutation = useMutation({
    mutationFn: (body: { from: string; to: string }) => api.post(`${base}/rename`, body),
    onSuccess: () => {
      refresh();
      toast.success('Renamed');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ key, recursive }: { key: string; recursive: boolean }) =>
      api.delete(
        `${base}/object?key=${encodeURIComponent(key)}${recursive ? '&recursive=true' : ''}`,
      ),
    onSuccess: () => {
      refresh();
      toast.success('Deleted');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  async function handleDownload(obj: StorageObject) {
    const path = `${base}/object?key=${encodeURIComponent(obj.key)}`;
    if (obj.size > STREAM_DOWNLOAD_BYTES) {
      const a = document.createElement('a');
      a.href = api.url(path);
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    try {
      await api.download(path, obj.name);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    }
  }

  function handleMkdir() {
    const name = prompt('New folder name');
    if (name?.trim()) mkdirMutation.mutate(prefix + name.trim());
  }

  function handleRename(obj: StorageObject) {
    const name = prompt('Rename to', obj.name);
    if (name && name !== obj.name) renameMutation.mutate({ from: obj.key, to: prefix + name });
  }

  function handleDeleteObject(obj: StorageObject) {
    if (confirm(`Delete "${obj.name}"?`)) deleteMutation.mutate({ key: obj.key, recursive: false });
  }

  function handleDeleteFolder(folder: StorageFolder) {
    if (confirm(`Delete folder "${folder.name}" and everything inside it?`)) {
      deleteMutation.mutate({ key: folder.prefix, recursive: true });
    }
  }

  function handleFilesChosen(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) uploadMutation.mutate(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  const segments = prefix.split('/').filter(Boolean);
  const isEmpty = folders.length === 0 && objects.length === 0;

  return (
    <div
      className="p-6"
      onDragOver={(e) => {
        if (canWrite) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (canWrite) handleFilesChosen(e.dataTransfer.files);
      }}
    >
      <div className="mb-6 flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate(`/storage/${id}`)}
              className="text-muted-foreground hover:text-foreground"
              title="Back to buckets"
            >
              <ArrowLeft size={16} />
            </button>
            <h1 className="truncate font-mono text-2xl font-bold">{bucket}</h1>
          </div>
          <p className="text-muted-foreground text-sm">Objects in this bucket</p>
        </div>
        <div className="flex items-center gap-2">
          {canWrite && (
            <>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium"
              >
                <Upload size={15} /> Upload
              </button>
              <button
                onClick={handleMkdir}
                className="border-border hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm"
              >
                <FolderPlus size={15} /> New folder
              </button>
            </>
          )}
          <button
            onClick={refresh}
            title="Refresh"
            className="border-border hover:bg-muted rounded-md border p-2"
          >
            <RefreshCw size={15} className={listQuery.isFetching ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => handleFilesChosen(e.target.files)}
      />

      {/* Breadcrumbs */}
      <div className="mb-3 flex flex-wrap items-center gap-1 text-sm">
        {parent != null && (
          <button
            onClick={() => setPrefix(parent)}
            title="Up one level"
            className="border-border hover:bg-muted mr-1 rounded-md border p-1"
          >
            <ArrowUp size={13} />
          </button>
        )}
        <button onClick={() => setPrefix('')} className="text-primary font-mono hover:underline">
          {bucket}
        </button>
        {segments.map((seg, i) => (
          <span key={`${seg}-${i}`} className="flex items-center gap-1">
            <span className="text-muted-foreground">/</span>
            <button
              onClick={() => setPrefix(`${segments.slice(0, i + 1).join('/')}/`)}
              className="text-primary font-mono hover:underline"
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      {uploadsInFlight > 0 && (
        <p className="text-muted-foreground mb-3 text-sm">
          Uploading {uploadsInFlight > 1 ? `${uploadsInFlight} files` : '1 file'}…
        </p>
      )}

      {listQuery.isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : listQuery.isError ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">
          {(listQuery.error as Error).message}
        </div>
      ) : isEmpty ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center py-16">
          <Folder size={40} className="mb-3 opacity-30" />
          <p>
            Nothing here yet.
            {canWrite ? ' Drop files here or click "Upload".' : ''}
          </p>
        </div>
      ) : (
        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="border-border text-muted-foreground border-b text-left">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="w-28 px-4 py-2 font-medium">Size</th>
                <th className="w-44 px-4 py-2 font-medium">Modified</th>
                <th className="w-32 px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {folders.map((folder) => (
                <tr
                  key={folder.prefix}
                  className="border-border hover:bg-muted/40 border-b last:border-0"
                >
                  <td className="px-4 py-2">
                    <button
                      onClick={() => setPrefix(folder.prefix)}
                      className="flex items-center gap-2 text-left hover:underline"
                    >
                      <Folder size={15} className="text-primary" />
                      <span className="font-mono">{folder.name}</span>
                    </button>
                  </td>
                  <td className="text-muted-foreground px-4 py-2">—</td>
                  <td className="text-muted-foreground px-4 py-2">—</td>
                  <td className="px-4 py-2">
                    {canWrite && (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleDeleteFolder(folder)}
                          title="Delete folder"
                          className="rounded-md p-1.5 text-red-500 hover:bg-red-500/10"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {objects.map((obj) => (
                <tr
                  key={obj.key}
                  className="border-border hover:bg-muted/40 border-b last:border-0"
                >
                  <td className="px-4 py-2">
                    <button
                      onClick={() => handleDownload(obj)}
                      className="flex items-center gap-2 text-left hover:underline"
                      title="Download"
                    >
                      <FileIcon size={15} className="text-muted-foreground" />
                      <span className="font-mono">{obj.name}</span>
                    </button>
                  </td>
                  <td className="text-muted-foreground px-4 py-2">{formatBytes(obj.size)}</td>
                  <td className="text-muted-foreground px-4 py-2">
                    {obj.modifiedAt ? new Date(obj.modifiedAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleDownload(obj)}
                        title="Download"
                        className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md p-1.5"
                      >
                        <Download size={13} />
                      </button>
                      {canWrite && (
                        <>
                          <button
                            onClick={() => handleRename(obj)}
                            title="Rename"
                            className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md p-1.5"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            onClick={() => handleDeleteObject(obj)}
                            title="Delete"
                            className="rounded-md p-1.5 text-red-500 hover:bg-red-500/10"
                          >
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {listQuery.hasNextPage && (
            <div className="border-border border-t p-3 text-center">
              <button
                onClick={() => listQuery.fetchNextPage()}
                disabled={listQuery.isFetchingNextPage}
                className="border-border hover:bg-muted rounded-md border px-4 py-1.5 text-sm disabled:opacity-50"
              >
                {listQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
