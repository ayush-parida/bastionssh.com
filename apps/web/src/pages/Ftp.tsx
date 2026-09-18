import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api.js';
import { useHasRole } from '@/store/auth.js';
import {
  FTP_PROTOCOL_OPTIONS,
  ftpProtocolOption,
  type CreateFtpConnectionRequest,
  type FtpConnection,
  type FtpProtocol,
  type FtpTestResult,
  type UpdateFtpConnectionRequest,
} from '@smt/shared';
import {
  CircleAlert,
  CircleCheck,
  FolderOpen,
  FolderSync,
  Pencil,
  PlugZap,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

interface ConnectionForm {
  name: string;
  protocol: FtpProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
  verifyTls: boolean;
  rootPath: string;
}

const empty: ConnectionForm = {
  name: '',
  protocol: 'ftps',
  host: '',
  port: '21',
  username: '',
  password: '',
  verifyTls: true,
  rootPath: '',
};

const QUERY_KEY = ['ftp-connections'];

const inputClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

function describeTarget(c: FtpConnection): string {
  return `${c.username}@${c.host}:${c.port}`;
}

export default function FtpPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canManage = useHasRole('admin');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<ConnectionForm>(empty);

  const { data: connections, isLoading } = useQuery<FtpConnection[]>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/ftp/connections'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: QUERY_KEY });

  const createMutation = useMutation({
    mutationFn: (body: CreateFtpConnectionRequest) =>
      api.post<FtpConnection>('/ftp/connections', body),
    onSuccess: () => {
      invalidate();
      closeForm();
      toast.success('Connection added');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateFtpConnectionRequest }) =>
      api.patch<FtpConnection>(`/ftp/connections/${id}`, body),
    onSuccess: () => {
      invalidate();
      closeForm();
      toast.success('Connection updated');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/ftp/connections/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success('Connection removed');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => api.post<FtpTestResult>(`/ftp/connections/${id}/test`),
    onSuccess: (result) => {
      invalidate();
      if (result.ok) {
        toast.success(
          `Connected — logged in at ${result.workingDirectory ?? '/'} (${result.entryCount ?? 0} entries)`,
        );
      } else {
        toast.error(result.error ?? 'Connection failed');
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function openCreate() {
    setEditId(null);
    setForm(empty);
    setShowForm(true);
  }

  function openEdit(c: FtpConnection) {
    setEditId(c.id);
    setForm({
      name: c.name,
      protocol: c.protocol,
      host: c.host,
      port: String(c.port),
      username: c.username,
      password: '',
      verifyTls: c.verifyTls,
      rootPath: c.rootPath ?? '',
    });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditId(null);
    setForm(empty);
  }

  const option = ftpProtocolOption(form.protocol);
  const usesTls = form.protocol !== 'ftp';

  function setProtocol(protocol: FtpProtocol) {
    setForm((p) => {
      // Only move the port when it is still the previous protocol's default,
      // so a custom port survives switching between explicit and implicit TLS.
      const wasDefault = p.port === String(ftpProtocolOption(p.protocol).defaultPort);
      return {
        ...p,
        protocol,
        port: wasDefault ? String(ftpProtocolOption(protocol).defaultPort) : p.port,
      };
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const port = Number(form.port);
    const rootPath = form.rootPath.trim() || null;
    if (editId) {
      updateMutation.mutate({
        id: editId,
        body: {
          name: form.name,
          protocol: form.protocol,
          host: form.host,
          port,
          username: form.username,
          // Blank means "keep the stored password" — it is never sent back to the client
          ...(form.password ? { password: form.password } : {}),
          verifyTls: form.verifyTls,
          rootPath,
        },
      });
    } else {
      createMutation.mutate({
        name: form.name,
        protocol: form.protocol,
        host: form.host,
        port,
        username: form.username,
        password: form.password,
        verifyTls: form.verifyTls,
        rootPath,
      });
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">FTP</h1>
          <p className="text-muted-foreground text-sm">
            Browse and manage files on FTP and FTPS servers — shared hosting, cPanel, legacy boxes
          </p>
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
                placeholder="Marketing site (cPanel)"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Protocol</label>
              <select
                value={form.protocol}
                onChange={(e) => setProtocol(e.target.value as FtpProtocol)}
                className={inputClass}
              >
                {FTP_PROTOCOL_OPTIONS.map((o) => (
                  <option key={o.protocol} value={o.protocol}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <p
              className={`col-span-2 -mt-2 text-xs ${
                form.protocol === 'ftp' ? 'text-amber-500' : 'text-muted-foreground'
              }`}
            >
              {option.hint}
            </p>
            <div>
              <label className="mb-1 block text-sm font-medium">Host</label>
              <input
                type="text"
                required
                value={form.host}
                onChange={(e) => setForm((p) => ({ ...p, host: e.target.value }))}
                placeholder="ftp.example.com"
                className={`${inputClass} font-mono`}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Port</label>
              <input
                type="number"
                required
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => setForm((p) => ({ ...p, port: e.target.value }))}
                className={`${inputClass} font-mono`}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Username</label>
              <input
                type="text"
                required
                autoComplete="off"
                value={form.username}
                onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))}
                className={`${inputClass} font-mono`}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Password</label>
              <input
                type="password"
                required={!editId}
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
                className={`${inputClass} font-mono`}
              />
              {editId && (
                <p className="text-muted-foreground mt-1 text-xs">
                  Leave blank to keep the existing password.
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                Start directory <span className="text-muted-foreground text-xs">(optional)</span>
              </label>
              <input
                type="text"
                value={form.rootPath}
                onChange={(e) => setForm((p) => ({ ...p, rootPath: e.target.value }))}
                placeholder="/public_html — blank opens the login directory"
                className={`${inputClass} font-mono`}
              />
            </div>
            <label
              className={`flex items-center gap-2 self-end pb-2 text-sm ${usesTls ? '' : 'opacity-50'}`}
            >
              <input
                type="checkbox"
                disabled={!usesTls}
                checked={form.verifyTls}
                onChange={(e) => setForm((p) => ({ ...p, verifyTls: e.target.checked }))}
                className="border-input size-4 rounded"
              />
              Verify TLS certificate
              <span className="text-muted-foreground text-xs">
                (untick for a self-signed certificate)
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
          <FolderSync size={40} className="mb-3 opacity-30" />
          <p>
            No FTP connections yet.
            {canManage ? ' Click "Add connection" to register an FTP or FTPS server.' : ''}
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
                  {c.rootPath && (
                    <p className="text-muted-foreground truncate font-mono text-xs">{c.rootPath}</p>
                  )}
                </div>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                    c.protocol === 'ftp'
                      ? 'bg-amber-500/10 text-amber-500'
                      : 'bg-muted text-muted-foreground'
                  }`}
                  title={ftpProtocolOption(c.protocol).label}
                >
                  {c.protocol === 'ftp' ? 'FTP · no TLS' : 'FTPS'}
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
                  onClick={() => navigate(`/ftp/${c.id}`)}
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
                            `Remove connection "${c.name}"? Files on the server are not touched.`,
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
