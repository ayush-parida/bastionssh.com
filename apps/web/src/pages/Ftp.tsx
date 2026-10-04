import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api.js';
import { useHasRole } from '@/store/auth.js';
import { useAccessLevels } from '@/hooks/useAccessLevels.js';
import {
  FTP_PROTOCOL_OPTIONS,
  ftpProtocolOption,
  type CreateFtpConnectionRequest,
  type FtpAuthMethod,
  type FtpConnection,
  type FtpProtocol,
  type FtpTestResult,
  type SSHKey,
  type UpdateFtpConnectionRequest,
} from '@smt/shared';
import {
  CircleAlert,
  CircleCheck,
  FolderOpen,
  FolderSync,
  KeyRound,
  Lock,
  Pencil,
  PlugZap,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { FtpHostKeySection } from '@/components/ftp/FtpHostKey.js';
import { DiagnoseButton, DiagnosticsDialog, connectionFailedToast } from '@/components/diagnostics/Diagnostics.js';
import { isConnectivityFailure, type DiagnoseTarget } from '@/lib/diagnostics.js';
import { WhoHasAccessButton } from '@/components/access/WhoHasAccess.js';

interface ConnectionForm {
  name: string;
  protocol: FtpProtocol;
  host: string;
  port: string;
  username: string;
  authMethod: FtpAuthMethod;
  password: string;
  sshKeyId: string;
  verifyTls: boolean;
  rootPath: string;
  restrictToRoot: boolean;
}

const empty: ConnectionForm = {
  name: '',
  protocol: 'ftps',
  host: '',
  port: '21',
  username: '',
  authMethod: 'password',
  password: '',
  sshKeyId: '',
  verifyTls: true,
  rootPath: '',
  // New connections are confined to their start directory unless unticked
  restrictToRoot: true,
};

const QUERY_KEY = ['ftp-connections'];

const inputClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

function describeTarget(c: FtpConnection): string {
  return `${c.username}@${c.host}:${c.port}`;
}

function protocolBadge(protocol: FtpProtocol): string {
  if (protocol === 'ftp') return 'FTP · no TLS';
  return protocol === 'sftp' ? 'SFTP' : 'FTPS';
}

export default function FtpPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Adding needs an admin; on each one, what the caller's level allows (custom roles spec §5, §7)
  const canAdd = useHasRole('admin');
  const access = useAccessLevels('ftp_connection');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<ConnectionForm>(empty);
  const [diagnosing, setDiagnosing] = useState<DiagnoseTarget | null>(null);

  const { data: connections, isLoading } = useQuery<FtpConnection[]>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/ftp/connections'),
  });

  // Only the connection form (admins) needs the org's keys, for key auth
  const { data: sshKeys } = useQuery<SSHKey[]>({
    queryKey: ['ssh-keys'],
    queryFn: () => api.get('/keys'),
    enabled: showForm,
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
    mutationFn: (c: FtpConnection) => api.post<FtpTestResult>(`/ftp/connections/${c.id}/test`),
    onSuccess: (result, c) => {
      invalidate();
      if (result.ok) {
        toast.success(
          `Connected — logged in at ${result.workingDirectory ?? '/'} (${result.entryCount ?? 0} entries)`,
        );
      } else {
        connectionFailedToast(
          result.error ?? 'Connection failed',
          { kind: 'ftp_connection', id: c.id, name: c.name },
          setDiagnosing,
        );
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
      authMethod: c.authMethod,
      password: '',
      sshKeyId: c.sshKeyId ?? '',
      verifyTls: c.verifyTls,
      rootPath: c.rootPath ?? '',
      restrictToRoot: c.restrictToRoot,
    });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditId(null);
    setForm(empty);
  }

  const option = ftpProtocolOption(form.protocol);
  // SFTP authenticates the host by its SSH key, not a certificate
  const usesTls = form.protocol !== 'ftp' && form.protocol !== 'sftp';
  // Key auth is SFTP only; FTP/FTPS always log in with the password
  const authMethod: FtpAuthMethod = form.protocol === 'sftp' ? form.authMethod : 'password';
  const editing = connections?.find((c) => c.id === editId);
  // A stored password can only be kept when the connection already logs in with one
  const passwordRequired = !editing || editing.authMethod !== 'password';

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
    const auth =
      authMethod === 'key'
        ? { authMethod, sshKeyId: form.sshKeyId }
        : { authMethod, ...(form.password ? { password: form.password } : {}) };
    if (editId) {
      updateMutation.mutate({
        id: editId,
        body: {
          name: form.name,
          protocol: form.protocol,
          host: form.host,
          port,
          username: form.username,
          // A blank password means "keep the stored one" — it is never sent back to the client
          ...auth,
          verifyTls: form.verifyTls,
          rootPath,
          restrictToRoot: form.restrictToRoot,
        },
      });
    } else {
      createMutation.mutate({
        name: form.name,
        protocol: form.protocol,
        host: form.host,
        port,
        username: form.username,
        ...auth,
        verifyTls: form.verifyTls,
        rootPath,
        restrictToRoot: form.restrictToRoot,
      });
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">FTP</h1>
          <p className="text-muted-foreground text-sm">
            Browse and manage files on FTP, FTPS and SFTP servers — shared hosting, cPanel,
            SFTP-only accounts, legacy boxes
          </p>
        </div>
        {canAdd && (
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
                placeholder={form.protocol === 'sftp' ? 'sftp.example.com' : 'ftp.example.com'}
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
            {form.protocol === 'sftp' && (
              <div>
                <label className="mb-1 block text-sm font-medium">Authentication</label>
                <select
                  value={form.authMethod}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, authMethod: e.target.value as FtpAuthMethod }))
                  }
                  className={inputClass}
                >
                  <option value="password">Password</option>
                  <option value="key">SSH key</option>
                </select>
              </div>
            )}
            {authMethod === 'key' ? (
              <div>
                <label className="mb-1 block text-sm font-medium">SSH key</label>
                <select
                  required
                  value={form.sshKeyId}
                  onChange={(e) => setForm((p) => ({ ...p, sshKeyId: e.target.value }))}
                  className={inputClass}
                >
                  <option value="">Choose a key…</option>
                  {sshKeys?.filter((k) => !k.retiredAt || k.id === form.sshKeyId).map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name} ({k.type})
                    </option>
                  ))}
                </select>
                {sshKeys?.length === 0 && (
                  <p className="text-muted-foreground mt-1 text-xs">
                    No SSH keys yet — generate or import one under Keys.
                  </p>
                )}
              </div>
            ) : (
              <div>
                <label className="mb-1 block text-sm font-medium">Password</label>
                <input
                  type="password"
                  required={passwordRequired}
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
                  className={`${inputClass} font-mono`}
                />
                {!passwordRequired && (
                  <p className="text-muted-foreground mt-1 text-xs">
                    Leave blank to keep the existing password.
                  </p>
                )}
              </div>
            )}
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
            <label className="col-span-2 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.restrictToRoot}
                onChange={(e) => setForm((p) => ({ ...p, restrictToRoot: e.target.checked }))}
                className="border-input mt-0.5 size-4 rounded"
              />
              <span>
                Restrict to the start directory
                <span className="text-muted-foreground block text-xs">
                  Every path must stay inside the start directory (or the login directory when
                  none is set).
                  {form.protocol === 'sftp'
                    ? ' Symlinks that lead out of it are refused too.'
                    : ' FTP cannot tell where a symlink leads, so paths are only checked by name.'}
                </span>
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
            {canAdd ? ' Click "Add connection" to register an FTP, FTPS or SFTP server.' : ''}
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
                  {(c.restrictToRoot || c.authMethod === 'key') && (
                    <p className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                      {c.restrictToRoot && (
                        <span
                          className="flex items-center gap-1"
                          title="Paths outside the start directory are refused"
                        >
                          <Lock size={10} /> Restricted
                        </span>
                      )}
                      {c.authMethod === 'key' && (
                        <span className="flex items-center gap-1" title="Logs in with an SSH key">
                          <KeyRound size={10} /> SSH key
                        </span>
                      )}
                    </p>
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
                  {protocolBadge(c.protocol)}
                </span>
              </div>
              {c.protocol === 'sftp' && <FtpHostKeySection connection={c} />}
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
                  {c.lastStatus !== 'ok' && isConnectivityFailure(c.lastError) && access.can(c.id, 'operate') && (
                    <button
                      onClick={() => setDiagnosing({ kind: 'ftp_connection', id: c.id, name: c.name })}
                      className="text-primary ml-1 shrink-0 font-medium hover:underline"
                    >
                      Run diagnostics
                    </button>
                  )}
                </p>
              )}
              <div className="mt-auto flex flex-wrap gap-2">
                <button
                  onClick={() => navigate(`/ftp/${c.id}`)}
                  className="bg-primary/10 text-primary hover:bg-primary/20 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium"
                >
                  <FolderOpen size={12} /> Browse
                </button>
                <DiagnoseButton
                  target={{ kind: 'ftp_connection', id: c.id, name: c.name }}
                  onOpen={setDiagnosing}
                />
                <WhoHasAccessButton type="ftp_connection" id={c.id} name={c.name} />
                {access.can(c.id, 'operate') && (
                  <button
                    onClick={() => testMutation.mutate(c)}
                    disabled={testMutation.isPending}
                    className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                  >
                    <PlugZap size={12} /> Test
                  </button>
                )}
                {access.can(c.id, 'manage') && (
                  <>
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

      {diagnosing && <DiagnosticsDialog target={diagnosing} onClose={() => setDiagnosing(null)} />}
    </div>
  );
}
