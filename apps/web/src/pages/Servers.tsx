import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api.js';
import {
  CLOUD_PROVIDER_LABEL,
  type Agent,
  HOST_KEY_FINGERPRINT_PATTERN,
  type ActiveRecording,
  type CreateServerRequest,
  type DockerMode,
  type MonitoringOverview,
  type Server,
  type ServerCloudInfo,
  type ServerStatus,
  type SSHKey,
} from '@smt/shared';
import { Activity, Cloud, Container, KeyRound, Plus, Terminal, Trash2, Pencil, FolderOpen, RadioTower, Rocket, RotateCw, Server as ServerIcon, Waypoints, X } from 'lucide-react';
import { toast } from 'sonner';
import { StatusDot } from '@/components/monitoring/StatusBadge.js';
import { formatUptime, statusMeta } from '@/lib/monitoring.js';
import { hostKeyPanelPath } from '@/lib/host-keys.js';
import { HostKeyBadge } from '@/components/servers/HostKey.js';
import { DiagnoseButton, DiagnosticsDialog, connectionFailedToast } from '@/components/diagnostics/Diagnostics.js';
import type { DiagnoseTarget } from '@/lib/diagnostics.js';
import { ExpiryBadge } from '@/components/access/ExpiryBadge.js';
import { RequestAccessDialog, useRequestableServers } from '@/components/access/RequestAccessDialog.js';
import { KeyAgeBadge, RotationHistory, rotationRequestError } from '@/components/keys/KeyRotation.js';
import { ROTATION_CONFIRM, rotateServerKey, rotateServerKeys, toastRotation } from '@/lib/key-rotation.js';
import { useModule } from '@/hooks/useModules.js';
import { useAccessLevels } from '@/hooks/useAccessLevels.js';
import { WhoHasAccessButton } from '@/components/access/WhoHasAccess.js';
import ServerDockerFields from '@/components/docker/ServerDockerFields.js';

interface ServerFormState {
  name: string;
  host: string;
  port: string;
  username: string;
  authType: 'key' | 'password';
  defaultKeyId: string;
  password: string;
  tags: string;
  /** Optional pinned host key; blank leaves it alone (trust on first use for a new server). */
  hostKeyFingerprint: string;
  /** Server to connect through (ssh -J); blank connects directly. */
  jumpServerId: string;
  /** Connectivity agent to go through; blank connects directly. */
  agentId: string;
  dockerMode: DockerMode;
  /** Docker socket override; blank detects. */
  dockerSocketPath: string;
}

const empty: ServerFormState = { name: '', host: '', port: '22', username: 'root', authType: 'key', defaultKeyId: '', password: '', tags: '', hostKeyFingerprint: '', jumpServerId: '', agentId: '', dockerMode: 'auto', dockerSocketPath: '' };

/** Tags are entered as a comma-separated list and stored as an array. */
function splitTags(input: string): string[] {
  return [...new Set(input.split(',').map((t) => t.trim()).filter(Boolean))];
}

/**
 * Whether `candidate` connects through `serverId`, directly or further down its
 * chain — offering it as `serverId`'s jump host would make a loop. The server
 * enforces this too; this only keeps such choices out of the list.
 */
function jumpsThrough(candidate: Server, serverId: string, byId: Map<string, Server>): boolean {
  const seen = new Set<string>();
  for (let s: Server | undefined = candidate; s && !seen.has(s.id); s = s.jumpServerId ? byId.get(s.jumpServerId) : undefined) {
    if (s.id === serverId) return true;
    seen.add(s.id);
  }
  return false;
}

/** `via bastion` badge for a server reached through a jump host. */
function JumpBadge({ jump }: { jump: Server | undefined }) {
  return (
    <span
      title={jump ? `Connections go through ${jump.name} (${jump.host}:${jump.port})` : 'Connections go through a jump host'}
      className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
    >
      <Waypoints size={11} /> via {jump?.name ?? 'jump host'}
    </span>
  );
}

/** `AWS · running` badge; amber when the provider says stopped, red when it no longer lists it. */
function CloudBadge({ cloud }: { cloud: ServerCloudInfo }) {
  const tone =
    cloud.state === 'missing'
      ? 'bg-red-500/10 text-red-600'
      : cloud.state === 'stopped'
        ? 'bg-amber-500/10 text-amber-600'
        : 'bg-muted text-muted-foreground';
  const synced = cloud.syncedAt ? ` · synced ${new Date(cloud.syncedAt).toLocaleString()}` : '';
  return (
    <span
      title={`${cloud.instanceId}${cloud.region ? ` in ${cloud.region}` : ''}${synced}`}
      className={`rounded px-1.5 py-0.5 text-xs ${tone}`}
    >
      {CLOUD_PROVIDER_LABEL[cloud.provider]} · {cloud.state}
    </span>
  );
}

export default function ServersPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<ServerFormState>(empty);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState<DiagnoseTarget | null>(null);
  const [requesting, setRequesting] = useState(false);
  const isAdmin = useModule('servers', 'manage');
  const deployments = useModule('deployments');
  // The level on each server (custom roles): hide what it does not allow
  const access = useAccessLevels('server');
  // Servers ticked for a bulk key rotation, and the batch last started
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchId, setBatchId] = useState<string | null>(null);

  const { data: servers, isLoading } = useQuery<Server[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/servers'),
  });

  const { data: keys } = useQuery<SSHKey[]>({
    queryKey: ['ssh-keys'],
    queryFn: () => api.get('/keys'),
  });

  // Agents are admin-only, as is editing servers
  const { data: agents } = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: () => api.get('/agents'),
    enabled: isAdmin,
  });
  const agentById = new Map((agents ?? []).map((a) => [a.id, a]));

  // Live health for the status dot on each card; the Monitoring page owns the detail.
  const { data: overview } = useQuery<MonitoringOverview>({
    queryKey: ['monitoring-overview'],
    queryFn: () => api.get('/monitoring/overview'),
    refetchInterval: 30_000,
  });

  const healthById = new Map((overview?.servers ?? []).map((h) => [h.serverId, h]));
  const serverById = new Map((servers ?? []).map((s) => [s.id, s]));

  // Restricted members: which of their servers are time-bound, and a way to ask for more
  const { data: requestable } = useRequestableServers();
  const grantExpiry = new Map(
    (requestable?.servers ?? []).flatMap((s) => (s.granted?.expiresAt ? [[s.id, s.granted.expiresAt] as const] : [])),
  );

  const allTags = [...new Set((servers ?? []).flatMap((s) => s.tags ?? []))].sort();
  const visibleServers = tagFilter
    ? (servers ?? []).filter((s) => (s.tags ?? []).includes(tagFilter))
    : servers ?? [];

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

  function refreshKeys() {
    void qc.invalidateQueries({ queryKey: ['servers'] });
    void qc.invalidateQueries({ queryKey: ['ssh-keys'] });
    void qc.invalidateQueries({ queryKey: ['key-rotations'] });
  }

  const rotateMutation = useMutation({
    mutationFn: (id: string) => rotateServerKey(id),
    onSuccess: (rotation) => { toastRotation(rotation); refreshKeys(); },
    onError: rotationRequestError,
  });

  const bulkRotateMutation = useMutation({
    mutationFn: (ids: string[]) => rotateServerKeys(ids),
    onSuccess: (res) => {
      setSelected(new Set());
      setBatchId(res.batchId);
      refreshKeys();
      toast.success(`Rotating ${res.rotations.length} server key(s) — progress below`);
    },
    onError: rotationRequestError,
  });

  const keysById = new Map((keys ?? []).map((k) => [k.id, k]));
  const canRotate = (s: Server) => s.authType === 'key' && !!s.defaultKeyId;

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleRotate(s: Server) {
    if (confirm(`Rotate the SSH key of ${s.name}?\n\n${ROTATION_CONFIRM}`)) rotateMutation.mutate(s.id);
  }

  function handleBulkRotate() {
    const ids = [...selected];
    if (confirm(`Rotate the SSH keys of ${ids.length} server(s)? Each gets its own new key; they are rotated one after another.\n\n${ROTATION_CONFIRM}`)) {
      bulkRotateMutation.mutate(ids);
    }
  }

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
      tags: (s.tags ?? []).join(', '),
      hostKeyFingerprint: s.hostKeyFingerprint ?? '',
      jumpServerId: s.jumpServerId ?? '',
      agentId: s.agentId ?? '',
      dockerMode: s.docker.mode,
      dockerSocketPath: s.docker.socketPath ?? '',
    });
    setShowForm(true);
  }

  async function handleConnect(server: Server) {
    try {
      const res = await api.post<{ sessionId: string; wsUrl: string; recording: ActiveRecording | null }>(
        '/ssh-sessions',
        { serverId: server.id },
      );
      navigate(`/servers/${server.id}/terminal`, {
        state: { sessionId: res.sessionId, serverName: server.name, recording: res.recording },
      });
    } catch (err: unknown) {
      connectionFailedToast(
        err instanceof Error ? err.message : 'Failed to open terminal',
        { kind: 'server', id: server.id, name: server.name },
        setDiagnosing,
      );
    }
  }

  // The server being edited, to tell a changed endpoint or fingerprint from a no-op
  const editing = editId ? servers?.find((s) => s.id === editId) : undefined;
  const endpointChanged =
    !!editing &&
    (form.host !== editing.host || form.port !== String(editing.port));

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fingerprint = form.hostKeyFingerprint.trim();
    if (fingerprint && !HOST_KEY_FINGERPRINT_PATTERN.test(fingerprint)) {
      toast.error('Host key fingerprint must look like SHA256: followed by 43 base64 characters');
      return;
    }
    // Send a fingerprint only when it was typed or changed — re-sending the old one
    // with a new host would re-pin it to an endpoint it says nothing about
    const sendFingerprint =
      !!fingerprint && (!editing || (fingerprint !== editing.hostKeyFingerprint));
    const body: CreateServerRequest = {
      name: form.name,
      host: form.host,
      port: Number(form.port),
      username: form.username,
      authType: form.authType,
      ...(form.authType === 'key' && form.defaultKeyId ? { defaultKeyId: form.defaultKeyId } : {}),
      ...(form.authType === 'password' && form.password ? { password: form.password } : {}),
      tags: splitTags(form.tags),
      ...(sendFingerprint ? { hostKeyFingerprint: fingerprint } : {}),
      // null clears it on an edit; a new server simply omits it
      ...(form.jumpServerId || editId ? { jumpServerId: form.jumpServerId || null } : {}),
      // Only when changed: a server keeps a revoked agent until an admin picks another
      ...(!editing || form.agentId !== (editing.agentId ?? '') ? { agentId: form.agentId || null } : {}),
      // Admin only; a new server sends them only when set, an edit only when changed
      ...(isAdmin && (editing ? form.dockerMode !== editing.docker.mode : form.dockerMode !== 'auto')
        ? { dockerMode: form.dockerMode }
        : {}),
      ...(isAdmin && form.dockerSocketPath.trim() !== (editing?.docker.socketPath ?? '')
        ? { dockerSocketPath: form.dockerSocketPath.trim() || null }
        : {}),
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
        <div className="flex items-center gap-2">
          {requestable?.restricted && (
            <button
              onClick={() => setRequesting(true)}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
            >
              <KeyRound size={15} /> Request access
            </button>
          )}
          {selected.size > 0 && (
            <>
              <button
                onClick={handleBulkRotate}
                disabled={bulkRotateMutation.isPending}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                <RotateCw size={15} /> Rotate keys ({selected.size})
              </button>
              <button onClick={() => setSelected(new Set())} title="Clear selection" className="rounded-md p-2 text-muted-foreground hover:bg-muted">
                <X size={15} />
              </button>
            </>
          )}
          <button
            onClick={() => { setShowForm(true); setEditId(null); setForm(empty); }}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus size={15} /> Add server
          </button>
        </div>
      </div>

      {requesting && <RequestAccessDialog onClose={() => setRequesting(false)} />}
      {batchId && (
        <div className="mb-6 rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 font-semibold"><RotateCw size={15} /> Key rotation</h2>
            <button onClick={() => setBatchId(null)} title="Close" className="rounded p-1 text-muted-foreground hover:bg-muted">
              <X size={14} />
            </button>
          </div>
          <RotationHistory batchId={batchId} />
        </div>
      )}

      {allTags.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground mr-1">Filter:</span>
          <button
            onClick={() => setTagFilter(null)}
            className={`rounded px-2 py-1 text-xs transition-colors ${
              tagFilter === null ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70'
            }`}
          >
            All ({servers?.length ?? 0})
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
              className={`rounded px-2 py-1 text-xs transition-colors ${
                tagFilter === tag ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

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
                  {keys?.filter((k) => !k.retiredAt || k.id === form.defaultKeyId).map((k) => (
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
            <div className="col-span-2">
              <label className="block text-sm font-medium mb-1">Connect via</label>
              <select
                value={form.agentId}
                onChange={(e) => setForm((prev) => ({ ...prev, agentId: e.target.value }))}
                // One route per server: a jump host or an agent
                disabled={!!form.jumpServerId && !form.agentId}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">Direct connection</option>
                {agents
                  ?.filter((a) => a.status !== 'revoked' || a.id === form.agentId)
                  .map((a) => (
                    <option key={a.id} value={a.id} disabled={a.status === 'revoked'}>
                      Agent: {a.name} ({a.status})
                    </option>
                  ))}
              </select>
              {form.agentId && (
                <p className="mt-1 text-xs text-muted-foreground">
                  The agent connects to 127.0.0.1 on the port above, from the host it runs on — the host field
                  is only a label. The port must be on the agent's allowlist.
                </p>
              )}
              {form.jumpServerId && !form.agentId && (
                <p className="mt-1 text-xs text-muted-foreground">Goes through the jump host below; clear it to use an agent.</p>
              )}
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium mb-1">
                Tags <span className="text-muted-foreground text-xs">(comma separated — target these with saved commands and role tag selectors)</span>
              </label>
              <input
                type="text"
                placeholder="prod, web, eu-west"
                value={form.tags}
                onChange={(e) => setForm((prev) => ({ ...prev, tags: e.target.value }))}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium mb-1">
                Jump host{' '}
                <span className="text-muted-foreground text-xs">
                  (optional — reach this server through another one, like <code className="font-mono">ssh -J</code>; up to 3 hops)
                </span>
              </label>
              <select
                value={form.jumpServerId}
                onChange={(e) => setForm((prev) => ({ ...prev, jumpServerId: e.target.value }))}
                disabled={!!form.agentId && !form.jumpServerId}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">— direct connection —</option>
                {(servers ?? [])
                  .filter((s) => !editId || !jumpsThrough(s, editId, serverById))
                  .map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.username}@{s.host}:{s.port})</option>
                  ))}
              </select>
              {form.jumpServerId && (
                <p className="mt-1 text-xs text-muted-foreground">
                  The jump host connects with its own credentials and host key; this server's key is still verified end to end.
                </p>
              )}
              {form.agentId && !form.jumpServerId && (
                <p className="mt-1 text-xs text-muted-foreground">Goes through the agent above; set it to a direct connection to use a jump host.</p>
              )}
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium mb-1">
                Host key fingerprint{' '}
                <span className="text-muted-foreground text-xs">
                  (optional — <code className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on the server; blank trusts the key seen on first connect)
                </span>
              </label>
              <input
                type="text"
                placeholder="SHA256:…"
                spellCheck={false}
                value={form.hostKeyFingerprint}
                onChange={(e) => setForm((prev) => ({ ...prev, hostKeyFingerprint: e.target.value }))}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              {endpointChanged && editing?.hostKeyFingerprint && form.hostKeyFingerprint.trim() === editing.hostKeyFingerprint && (
                <p className="mt-1 text-xs text-amber-600">
                  Changing the host or port forgets the pinned key — the next connection trusts the new endpoint's key unless you enter its fingerprint here.
                </p>
              )}
            </div>
            {isAdmin && (
              <ServerDockerFields
                mode={form.dockerMode}
                socketPath={form.dockerSocketPath}
                onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
                editing={editing}
              />
            )}
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
      ) : visibleServers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <ServerIcon size={40} className="mb-3 opacity-30" />
          <p>
            {tagFilter
              ? `No servers tagged "${tagFilter}".`
              : 'No servers added yet. Click "Add server" to get started.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {visibleServers.map((s) => (
            <div key={s.id} className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-semibold">
                    {isAdmin && canRotate(s) && (
                      <input
                        type="checkbox"
                        checked={selected.has(s.id)}
                        onChange={() => toggleSelected(s.id)}
                        title="Select for bulk key rotation"
                        className="shrink-0"
                      />
                    )}
                    <span className="truncate">{s.name}</span>
                  </p>
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
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => navigate(hostKeyPanelPath(s.id))}
                  title="Host key details"
                  className="rounded transition-opacity hover:opacity-80"
                >
                  <HostKeyBadge status={s.hostKeyStatus} />
                </button>
                {s.jumpServerId && <JumpBadge jump={serverById.get(s.jumpServerId)} />}
                {s.agentId && (
                  <span
                    title={agentById.get(s.agentId) ? `Through agent ${agentById.get(s.agentId)!.name} (${agentById.get(s.agentId)!.status})` : 'Through a connectivity agent'}
                    className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
                      agentById.get(s.agentId)?.status === 'revoked' ? 'bg-red-500/10 text-red-500' : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    <RadioTower size={11} /> {agentById.get(s.agentId)?.name ?? 'agent'}
                  </span>
                )}
                {s.defaultKeyId && keysById.get(s.defaultKeyId) && s.authType === 'key' && (
                  <KeyAgeBadge sshKey={keysById.get(s.defaultKeyId)!} />
                )}
                {s.cloud && <CloudBadge cloud={s.cloud} />}
                {grantExpiry.has(s.id) && <ExpiryBadge expiresAt={grantExpiry.get(s.id)!} />}
                {s.tags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                    className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
                      tagFilter === tag
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-muted/70'
                    }`}
                  >
                    {tag}
                  </button>
                ))}
                {(s.cloud?.tags ?? []).map((tag) => (
                  <span
                    key={`provider:${tag}`}
                    title={`Provider tag from ${CLOUD_PROVIDER_LABEL[s.cloud!.provider]} — shown for reference, never used for access`}
                    className="flex items-center gap-1 rounded border border-dashed border-border px-1.5 py-0.5 text-xs text-muted-foreground"
                  >
                    <Cloud size={10} /> {tag}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 mt-auto">
                {access.can(s.id, 'operate') && (
                  <button onClick={() => handleConnect(s)} className="flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20">
                    <Terminal size={12} /> Connect
                  </button>
                )}
                {access.can(s.id, 'operate') && (
                  <button onClick={() => navigate(`/servers/${s.id}/files`)} className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted">
                    <FolderOpen size={12} /> Files
                  </button>
                )}
                <button onClick={() => navigate(`/servers/${s.id}/health`)} className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted">
                  <Activity size={12} /> Health
                </button>
                {s.docker.mode === 'auto' && (s.docker.detectedAt || isAdmin) && (
                  <button onClick={() => navigate(`/servers/${s.id}/docker`)} className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted">
                    <Container size={12} /> Docker
                  </button>
                )}
                {deployments && (
                  <button onClick={() => navigate(`/servers/${s.id}/deployments`)} className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted">
                    <Rocket size={12} /> Deployments
                  </button>
                )}
                <DiagnoseButton target={{ kind: 'server', id: s.id, name: s.name }} onOpen={setDiagnosing} />
                {access.can(s.id, 'manage') && (
                  <button onClick={() => handleEdit(s)} className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted">
                    <Pencil size={12} /> Edit
                  </button>
                )}
                <WhoHasAccessButton type="server" id={s.id} name={s.name} />
                {isAdmin && canRotate(s) && (
                  <button
                    onClick={() => handleRotate(s)}
                    disabled={rotateMutation.isPending}
                    title="Rotate this server's SSH key"
                    className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                  >
                    <RotateCw size={12} className={rotateMutation.isPending && rotateMutation.variables === s.id ? 'animate-spin' : undefined} /> Rotate
                  </button>
                )}
                {access.can(s.id, 'manage') && (
                  <button onClick={() => { if (confirm('Delete this server?')) deleteMutation.mutate(s.id); }} className="ml-auto flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-500/10">
                    <Trash2 size={12} />
                  </button>
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
