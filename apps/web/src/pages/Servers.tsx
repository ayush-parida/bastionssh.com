import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api.js';
import type { Server, CreateServerRequest, MonitoringOverview, ServerStatus } from '@smt/shared';
import type { SSHKey } from '@smt/shared';
import { Activity, Plus, Terminal, Trash2, Pencil, FolderOpen, Server as ServerIcon } from 'lucide-react';
import { toast } from 'sonner';
import { StatusDot } from '@/components/monitoring/StatusBadge.js';
import { formatUptime, statusMeta } from '@/lib/monitoring.js';

interface ServerFormState {
  name: string;
  host: string;
  port: string;
  username: string;
  authType: 'key' | 'password';
  defaultKeyId: string;
  password: string;
}

const empty: ServerFormState = { name: '', host: '', port: '22', username: 'root', authType: 'key', defaultKeyId: '', password: '' };

export default function ServersPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<ServerFormState>(empty);

  const { data: servers, isLoading } = useQuery<Server[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/servers'),
  });

  const { data: keys } = useQuery<SSHKey[]>({
    queryKey: ['ssh-keys'],
    queryFn: () => api.get('/keys'),
  });

  // Live health for the status dot on each card; the Monitoring page owns the detail.
  const { data: overview } = useQuery<MonitoringOverview>({
    queryKey: ['monitoring-overview'],
    queryFn: () => api.get('/monitoring/overview'),
    refetchInterval: 30_000,
  });

  const healthById = new Map((overview?.servers ?? []).map((h) => [h.serverId, h]));

  const createMutation = useMutation({
    mutationFn: (body: CreateServerRequest) => api.post<Server>('/servers', body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['servers'] }); setShowForm(false); setForm(empty); toast.success('Server added'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CreateServerRequest> }) => api.patch<Server>(`/servers/${id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['servers'] }); setShowForm(false); setEditId(null); setForm(empty); toast.success('Server updated'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/servers/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['servers'] }); toast.success('Server deleted'); },
    onError: (err: Error) => toast.error(err.message),
  });

  function handleEdit(s: Server) {
    setEditId(s.id);
    setForm({
      name: s.name,
      host: s.host,
      port: String(s.port),
      username: s.username,
      authType: s.authType ?? 'key',
      defaultKeyId: s.defaultKeyId ?? '',
      password: '',
    });
    setShowForm(true);
  }

  async function handleConnect(server: Server) {
    try {
      const res = await api.post<{ sessionId: string; wsUrl: string }>('/ssh-sessions', { serverId: server.id });
      navigate(`/servers/${server.id}/terminal`, { state: { sessionId: res.sessionId, serverName: server.name } });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to open terminal');
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body: CreateServerRequest = {
      name: form.name,
      host: form.host,
      port: Number(form.port),
      username: form.username,
      authType: form.authType,
      ...(form.authType === 'key' && form.defaultKeyId ? { defaultKeyId: form.defaultKeyId } : {}),
      ...(form.authType === 'password' && form.password ? { password: form.password } : {}),
    };
    if (editId) updateMutation.mutate({ id: editId, body });
    else createMutation.mutate(body);
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Servers</h1>
          <p className="text-muted-foreground text-sm">Manage SSH server connections</p>
        </div>
        <button
          onClick={() => { setShowForm(true); setEditId(null); setForm(empty); }}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus size={15} /> Add server
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-lg border border-border bg-card p-5">
          <h2 className="font-semibold mb-4">{editId ? 'Edit server' : 'New server'}</h2>
          <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
            {(['name', 'host', 'port', 'username'] as const).map((f) => (
              <div key={f}>
                <label className="block text-sm font-medium mb-1 capitalize">{f}</label>
                <input
                  type={f === 'port' ? 'number' : 'text'}
                  required
                  value={form[f]}
                  onChange={(e) => setForm((prev) => ({ ...prev, [f]: e.target.value }))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            ))}
            <div className="col-span-2">
              <label className="block text-sm font-medium mb-1">Authentication</label>
              <div className="flex gap-3 mb-3">
                {(['key', 'password'] as const).map((t) => (
                  <label key={t} className="flex items-center gap-1.5 cursor-pointer text-sm">
                    <input
                      type="radio"
                      name="authType"
                      value={t}
                      checked={form.authType === t}
                      onChange={() => setForm((prev) => ({ ...prev, authType: t }))}
                    />
                    {t === 'key' ? 'SSH Key' : 'Password'}
                  </label>
                ))}
              </div>
              {form.authType === 'key' ? (
                <select
                  value={form.defaultKeyId}
                  onChange={(e) => setForm((prev) => ({ ...prev, defaultKeyId: e.target.value }))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">— none —</option>
                  {keys?.map((k) => (
                    <option key={k.id} value={k.id}>{k.name} ({k.type})</option>
                  ))}
                </select>
              ) : (
                <input
                  type="password"
                  placeholder="SSH password"
                  value={form.password}
                  onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              )}
            </div>
            <div className="col-span-2 flex gap-2">
              <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                {editId ? 'Update' : 'Add'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : servers?.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <ServerIcon size={40} className="mb-3 opacity-30" />
          <p>No servers added yet. Click "Add server" to get started.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {servers?.map((s) => (
            <div key={s.id} className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold truncate">{s.name}</p>
                  <p className="text-sm text-muted-foreground font-mono truncate">{s.username}@{s.host}:{s.port}</p>
                </div>
                {(() => {
                  const health = healthById.get(s.id);
                  const status: ServerStatus = health?.status ?? 'unknown';
                  return (
                    <button
                      onClick={() => navigate(`/servers/${s.id}/health`)}
                      title={`${statusMeta(status).label}${health?.uptimeSeconds != null ? ` · up ${formatUptime(health.uptimeSeconds)}` : ''}`}
                      className="mt-1 flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                    >
                      {health?.status === 'online' && health.cpuPercent != null && (
                        <span className="font-mono">{Math.round(health.cpuPercent)}%</span>
                      )}
                      <StatusDot status={status} />
                    </button>
                  );
                })()}
              </div>
              <div className="flex gap-2 mt-auto">
                <button onClick={() => handleConnect(s)} className="flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20">
                  <Terminal size={12} /> Connect
                </button>
                <button onClick={() => navigate(`/servers/${s.id}/files`)} className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted">
                  <FolderOpen size={12} /> Files
                </button>
                <button onClick={() => navigate(`/servers/${s.id}/health`)} className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted">
                  <Activity size={12} /> Health
                </button>
                <button onClick={() => handleEdit(s)} className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted">
                  <Pencil size={12} /> Edit
                </button>
                <button onClick={() => { if (confirm('Delete this server?')) deleteMutation.mutate(s.id); }} className="ml-auto flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-500/10">
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
