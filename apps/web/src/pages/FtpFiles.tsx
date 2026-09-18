import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '@/lib/api.js';
import { formatBytes } from '@/lib/utils.js';
import { useHasRole } from '@/store/auth.js';
import type { FtpConnection, FtpEntry, FtpListResponse, FtpUploadResponse } from '@smt/shared';
import {
  ArrowLeft,
  ArrowUp,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  Link2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';

function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function iconFor(entry: FtpEntry) {
  if (entry.type === 'directory') return <Folder size={15} className="text-primary" />;
  if (entry.type === 'symlink') return <Link2 size={15} className="text-muted-foreground" />;
  return <FileIcon size={15} className="text-muted-foreground" />;
}

/** MLSD gives a real timestamp; a plain LIST only gives whatever the server printed. */
function modified(entry: FtpEntry): string {
  if (entry.modifiedAt) return new Date(entry.modifiedAt).toLocaleString();
  return entry.rawModifiedAt || '—';
}

export default function FtpFilesPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // `.` asks the server for the connection's start directory
  const [path, setPath] = useState('.');
  // One upload can finish while another is still going, so count rather than flag
  const [uploadsInFlight, setUploadsInFlight] = useState(0);

  // Server enforces these too — this only keeps unusable controls off the screen
  const canWrite = useHasRole('operator');

  const { data: connection } = useQuery<FtpConnection>({
    queryKey: ['ftp-connections', id],
    queryFn: () => api.get(`/ftp/connections/${id}`),
    enabled: !!id,
  });

  const base = `/ftp/connections/${id}`;

  const listQuery = useQuery<FtpListResponse>({
    queryKey: ['ftp-files', id, path],
    queryFn: () => api.get(`${base}/list?path=${encodeURIComponent(path)}`),
    enabled: !!id,
    retry: false,
  });

  const cwd = listQuery.data?.path ?? path;

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['ftp-files', id] });
  }

  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      api.upload<FtpUploadResponse>(
        `${base}/file?path=${encodeURIComponent(join(cwd, file.name))}`,
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
    mutationFn: (target: string) => api.post(`${base}/mkdir`, { path: target }),
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
    mutationFn: ({ target, recursive }: { target: string; recursive: boolean }) =>
      api.delete(
        `${base}/file?path=${encodeURIComponent(target)}${recursive ? '&recursive=true' : ''}`,
      ),
    onSuccess: () => {
      refresh();
      toast.success('Deleted');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  async function handleDownload(entry: FtpEntry) {
    try {
      await api.download(`${base}/download?path=${encodeURIComponent(entry.path)}`, entry.name);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    }
  }

  function handleMkdir() {
    const name = prompt('New folder name');
    if (name?.trim()) mkdirMutation.mutate(join(cwd, name.trim()));
  }

  function handleRename(entry: FtpEntry) {
    const name = prompt('Rename to', entry.name);
    if (name && name !== entry.name) {
      renameMutation.mutate({ from: entry.path, to: join(cwd, name) });
    }
  }

  function handleDelete(entry: FtpEntry) {
    const isDir = entry.type === 'directory';
    if (!confirm(`Delete ${isDir ? 'folder' : 'file'} "${entry.name}"?`)) return;
    const recursive =
      isDir && confirm('Delete contents recursively? Cancel to require it be empty.');
    deleteMutation.mutate({ target: entry.path, recursive });
  }

  function handleFilesChosen(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) uploadMutation.mutate(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // Breadcrumb segments for the resolved directory
  const segments = cwd === '.' ? [] : cwd.split('/').filter(Boolean);

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
              onClick={() => navigate('/ftp')}
              className="text-muted-foreground hover:text-foreground"
              title="Back to connections"
            >
              <ArrowLeft size={16} />
            </button>
            <h1 className="truncate text-2xl font-bold">{connection?.name ?? 'Files'}</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            {connection
              ? `${connection.protocol === 'ftp' ? 'FTP' : 'FTPS'} · ${connection.username}@${connection.host}:${connection.port}`
              : (id ?? '')}
          </p>
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
        {listQuery.data?.parent != null && (
          <button
            onClick={() => setPath(listQuery.data!.parent!)}
            title="Up one level"
            className="border-border hover:bg-muted mr-1 rounded-md border p-1"
          >
            <ArrowUp size={13} />
          </button>
        )}
        <button onClick={() => setPath('/')} className="text-primary font-mono hover:underline">
          /
        </button>
        {segments.map((seg, i) => (
          <span key={`${seg}-${i}`} className="flex items-center gap-1">
            <button
              onClick={() => setPath(`/${segments.slice(0, i + 1).join('/')}`)}
              className="text-primary font-mono hover:underline"
            >
              {seg}
            </button>
            {i < segments.length - 1 && <span className="text-muted-foreground">/</span>}
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
      ) : listQuery.data?.entries.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center py-16">
          <Folder size={40} className="mb-3 opacity-30" />
          <p>
            This folder is empty.
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
                <th className="w-32 px-4 py-2 font-medium">Permissions</th>
                <th className="w-44 px-4 py-2 font-medium">Modified</th>
                <th className="w-32 px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {listQuery.data?.entries.map((entry) => (
                <tr
                  key={entry.path}
                  className="border-border hover:bg-muted/40 border-b last:border-0"
                >
                  <td className="px-4 py-2">
                    <button
                      onClick={() =>
                        entry.type === 'directory' || entry.type === 'symlink'
                          ? setPath(entry.path)
                          : handleDownload(entry)
                      }
                      className="flex items-center gap-2 text-left hover:underline"
                      title={entry.type === 'file' ? 'Download' : undefined}
                    >
                      {iconFor(entry)}
                      <span className="font-mono">{entry.name}</span>
                      {entry.link && (
                        <span className="text-muted-foreground font-mono text-xs">
                          → {entry.link}
                        </span>
                      )}
                    </button>
                  </td>
                  <td className="text-muted-foreground px-4 py-2">
                    {entry.type === 'directory' ? '—' : formatBytes(entry.size)}
                  </td>
                  <td className="text-muted-foreground px-4 py-2 font-mono text-xs">
                    {entry.permissions ?? '—'}
                  </td>
                  <td className="text-muted-foreground px-4 py-2">{modified(entry)}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {entry.type === 'file' && (
                        <button
                          onClick={() => handleDownload(entry)}
                          title="Download"
                          className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md p-1.5"
                        >
                          <Download size={13} />
                        </button>
                      )}
                      {canWrite && (
                        <>
                          <button
                            onClick={() => handleRename(entry)}
                            title="Rename"
                            className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md p-1.5"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            onClick={() => handleDelete(entry)}
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
        </div>
      )}
    </div>
  );
}
