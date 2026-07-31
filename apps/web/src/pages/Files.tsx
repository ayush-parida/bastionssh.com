import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '@/lib/api.js';
import type { Server, SftpEntry, SftpListResponse, SftpReadResponse } from '@smt/shared';
import { useHasRole } from '@/store/auth.js';
import {
  ArrowLeft,
  ArrowUp,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  Link2,
  FileCode,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function iconFor(entry: SftpEntry) {
  if (entry.type === 'directory') return <Folder size={15} className="text-primary" />;
  if (entry.type === 'symlink') return <Link2 size={15} className="text-muted-foreground" />;
  return <FileIcon size={15} className="text-muted-foreground" />;
}

export default function FilesPage() {
  const { id: serverId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // `.` asks the server for the login user's home directory
  const [path, setPath] = useState('.');
  const [editor, setEditor] = useState<{ path: string; draft: string; original: string } | null>(
    null,
  );
  const [editorLoading, setEditorLoading] = useState(false);

  // Server enforces these too — this only keeps unusable controls off the screen
  const canWrite = useHasRole('operator');

  const { data: server } = useQuery<Server>({
    queryKey: ['servers', serverId],
    queryFn: () => api.get(`/servers/${serverId}`),
    enabled: !!serverId,
  });

  const listQuery = useQuery<SftpListResponse>({
    queryKey: ['sftp', serverId, path],
    queryFn: () => api.get(`/sftp/${serverId}/list?path=${encodeURIComponent(path)}`),
    enabled: !!serverId,
    retry: false,
  });

  const cwd = listQuery.data?.path ?? path;

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['sftp', serverId] });
  }

  const mkdirMutation = useMutation({
    mutationFn: (target: string) => api.post(`/sftp/${serverId}/mkdir`, { path: target }),
    onSuccess: () => {
      refresh();
      toast.success('Folder created');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const renameMutation = useMutation({
    mutationFn: (body: { from: string; to: string }) =>
      api.post(`/sftp/${serverId}/rename`, body),
    onSuccess: () => {
      refresh();
      toast.success('Renamed');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ target, recursive }: { target: string; recursive: boolean }) =>
      api.delete(
        `/sftp/${serverId}/file?path=${encodeURIComponent(target)}&recursive=${recursive}`,
      ),
    onSuccess: () => {
      refresh();
      toast.success('Deleted');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      api.upload(`/sftp/${serverId}/file?path=${encodeURIComponent(join(cwd, file.name))}`, file),
    onSuccess: (_res, file) => {
      refresh();
      toast.success(`Uploaded ${file.name}`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  async function handleOpenEditor(entry: SftpEntry) {
    setEditorLoading(true);
    try {
      const res = await api.get<SftpReadResponse>(
        `/sftp/${serverId}/read?path=${encodeURIComponent(entry.path)}`,
      );
      if (res.truncated) toast.warning('File was truncated — saving would lose the remainder');
      setEditor({ path: res.path, draft: res.content, original: res.content });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not open file');
    } finally {
      setEditorLoading(false);
    }
  }

  const saveMutation = useMutation({
    mutationFn: ({ target, content }: { target: string; content: string }) =>
      api.upload(
        `/sftp/${serverId}/file?path=${encodeURIComponent(target)}`,
        new Blob([content], { type: 'application/octet-stream' }),
      ),
    onSuccess: (_res, { content }) => {
      setEditor((prev) => (prev ? { ...prev, original: content } : prev));
      refresh();
      toast.success('Saved');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function closeEditor() {
    if (editor && editor.draft !== editor.original && !confirm('Discard unsaved changes?')) return;
    setEditor(null);
  }

  async function handleDownload(entry: SftpEntry) {
    try {
      await api.download(
        `/sftp/${serverId}/download?path=${encodeURIComponent(entry.path)}`,
        entry.name,
      );
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    }
  }

  function handleMkdir() {
    const name = prompt('New folder name');
    if (name) mkdirMutation.mutate(join(cwd, name));
  }

  function handleRename(entry: SftpEntry) {
    const name = prompt('Rename to', entry.name);
    if (name && name !== entry.name) {
      renameMutation.mutate({ from: entry.path, to: join(cwd, name) });
    }
  }

  function handleDelete(entry: SftpEntry) {
    const isDir = entry.type === 'directory';
    if (!confirm(`Delete ${isDir ? 'folder' : 'file'} "${entry.name}"?`)) return;
    const recursive = isDir && confirm('Delete contents recursively? Cancel to require it be empty.');
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
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (canWrite) handleFilesChosen(e.dataTransfer.files);
      }}
    >
      <div className="flex items-center justify-between mb-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate('/servers')}
              className="text-muted-foreground hover:text-foreground"
              title="Back to servers"
            >
              <ArrowLeft size={16} />
            </button>
            <h1 className="text-2xl font-bold truncate">Files</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            SFTP on {server ? `${server.username}@${server.host}` : (serverId ?? '')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canWrite && (
            <>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                <Upload size={15} /> Upload
              </button>
              <button
                onClick={handleMkdir}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
              >
                <FolderPlus size={15} /> New folder
              </button>
            </>
          )}
          <button
            onClick={refresh}
            title="Refresh"
            className="rounded-md border border-border p-2 hover:bg-muted"
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
            className="mr-1 rounded-md border border-border p-1 hover:bg-muted"
          >
            <ArrowUp size={13} />
          </button>
        )}
        <button onClick={() => setPath('/')} className="font-mono text-primary hover:underline">
          /
        </button>
        {segments.map((seg, i) => (
          <span key={`${seg}-${i}`} className="flex items-center gap-1">
            <button
              onClick={() => setPath(`/${segments.slice(0, i + 1).join('/')}`)}
              className="font-mono text-primary hover:underline"
            >
              {seg}
            </button>
            {i < segments.length - 1 && <span className="text-muted-foreground">/</span>}
          </span>
        ))}
      </div>

      {uploadMutation.isPending && (
        <p className="mb-3 text-sm text-muted-foreground">Uploading…</p>
      )}

      {listQuery.isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : listQuery.isError ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">
          {(listQuery.error as Error).message}
        </div>
      ) : listQuery.data?.entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Folder size={40} className="mb-3 opacity-30" />
          <p>
            This folder is empty.
            {canWrite ? ' Drop files here or click "Upload".' : ''}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium w-28">Size</th>
                <th className="px-4 py-2 font-medium w-32">Permissions</th>
                <th className="px-4 py-2 font-medium w-44">Modified</th>
                <th className="px-4 py-2 font-medium w-32" />
              </tr>
            </thead>
            <tbody>
              {listQuery.data?.entries.map((entry) => (
                <tr key={entry.path} className="border-b border-border last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2">
                    <button
                      onClick={() =>
                        entry.type === 'directory' || entry.type === 'symlink'
                          ? setPath(entry.path)
                          : handleOpenEditor(entry)
                      }
                      className="flex items-center gap-2 text-left hover:underline"
                    >
                      {iconFor(entry)}
                      <span className="font-mono">{entry.name}</span>
                    </button>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {entry.type === 'directory' ? '—' : formatSize(entry.size)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                    {entry.permissions}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {new Date(entry.modifiedAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {entry.type === 'file' && (
                        <>
                          <button
                            onClick={() => handleOpenEditor(entry)}
                            title="Edit"
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <FileCode size={13} />
                          </button>
                          <button
                            onClick={() => handleDownload(entry)}
                            title="Download"
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <Download size={13} />
                          </button>
                        </>
                      )}
                      {canWrite && (
                        <>
                          <button
                            onClick={() => handleRename(entry)}
                            title="Rename"
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
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

      {editorLoading && !editor && <p className="mt-3 text-sm text-muted-foreground">Opening…</p>}

      {editor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeEditor();
          }}
        >
          <div className="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl">
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <FileCode size={16} className="text-primary shrink-0" />
              <span className="flex-1 truncate font-mono text-sm">{editor.path}</span>
              {editor.draft !== editor.original && (
                <span className="text-xs text-amber-500">unsaved</span>
              )}
              {canWrite && (
                <button
                  onClick={() =>
                    saveMutation.mutate({ target: editor.path, content: editor.draft })
                  }
                  disabled={saveMutation.isPending || editor.draft === editor.original}
                  className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                >
                  <Save size={14} /> {saveMutation.isPending ? 'Saving…' : 'Save'}
                </button>
              )}
              <button
                onClick={closeEditor}
                title="Close"
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>
            <textarea
              value={editor.draft}
              readOnly={!canWrite}
              spellCheck={false}
              onChange={(e) => setEditor({ ...editor, draft: e.target.value })}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault();
                  if (canWrite && editor.draft !== editor.original) {
                    saveMutation.mutate({ target: editor.path, content: editor.draft });
                  }
                }
              }}
              className="flex-1 resize-none bg-background p-4 font-mono text-sm leading-relaxed focus:outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}
