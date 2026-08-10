import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import type { NotificationChannel, NotificationTestResult } from '@smt/shared';
import { Plus, Trash2, Pencil, Send, BellRing, Webhook, Hash, CircleAlert, CircleCheck } from 'lucide-react';
import { toast } from 'sonner';

interface ChannelForm {
  name: string;
  type: 'webhook' | 'slack';
  url: string;
  minSeverity: 'warning' | 'critical';
  notifyOnResolve: boolean;
}

const emptyForm: ChannelForm = {
  name: '',
  type: 'slack',
  url: '',
  minSeverity: 'warning',
  notifyOnResolve: true,
};

const QUERY_KEY = ['notification-channels'];

export default function NotificationChannels() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ChannelForm>(emptyForm);

  const { data: channels } = useQuery<NotificationChannel[]>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/notifications/channels'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: QUERY_KEY });

  const createMutation = useMutation({
    mutationFn: (body: ChannelForm) => api.post('/notifications/channels', body),
    onSuccess: () => { invalidate(); closeForm(); toast.success('Channel added'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: ChannelForm }) =>
      api.patch(`/notifications/channels/${id}`, {
        name: body.name,
        // Blank means "keep the stored URL" — it is never sent back to the client
        ...(body.url ? { url: body.url } : {}),
        minSeverity: body.minSeverity,
        notifyOnResolve: body.notifyOnResolve,
      }),
    onSuccess: () => { invalidate(); closeForm(); toast.success('Channel updated'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch(`/notifications/channels/${id}`, { enabled }),
    onSuccess: () => invalidate(),
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/notifications/channels/${id}`),
    onSuccess: () => { invalidate(); toast.success('Channel removed'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => api.post<NotificationTestResult>(`/notifications/channels/${id}/test`),
    onSuccess: (result) => {
      invalidate();
      if (result.ok) toast.success('Test notification delivered');
      else toast.error(result.error ?? 'Delivery failed');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function openEdit(channel: NotificationChannel) {
    setEditingId(channel.id);
    setForm({
      name: channel.name,
      type: channel.type,
      url: '',
      minSeverity: channel.minSeverity,
      notifyOnResolve: channel.notifyOnResolve,
    });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editingId) updateMutation.mutate({ id: editingId, body: form });
    else createMutation.mutate(form);
  }

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold">Alert notifications</h2>
        <button
          onClick={() => { setEditingId(null); setForm(emptyForm); setShowForm(true); }}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus size={14} /> Add channel
        </button>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Where to send monitoring alerts when a server goes down or crosses a threshold.
      </p>

      {showForm && (
        <div className="mb-4 rounded-lg border border-border bg-card p-5">
          <h3 className="text-sm font-semibold mb-3">{editingId ? 'Edit channel' : 'New channel'}</h3>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="#ops-alerts"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Type</label>
                <select
                  value={form.type}
                  disabled={editingId !== null}
                  onChange={(e) => setForm((p) => ({ ...p, type: e.target.value as ChannelForm['type'] }))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                >
                  <option value="slack">Slack (incoming webhook)</option>
                  <option value="webhook">Webhook (JSON POST)</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">URL</label>
              <input
                type="url"
                required={!editingId}
                value={form.url}
                onChange={(e) => setForm((p) => ({ ...p, url: e.target.value }))}
                placeholder={form.type === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://example.com/hooks/alerts'}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary"
              />
              {editingId && (
                <p className="mt-1 text-xs text-muted-foreground">Leave blank to keep the existing URL.</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Send when</label>
                <select
                  value={form.minSeverity}
                  onChange={(e) => setForm((p) => ({ ...p, minSeverity: e.target.value as ChannelForm['minSeverity'] }))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="warning">Warning and above</option>
                  <option value="critical">Critical only</option>
                </select>
              </div>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.notifyOnResolve}
                  onChange={(e) => setForm((p) => ({ ...p, notifyOnResolve: e.target.checked }))}
                  className="size-4 rounded border-input"
                />
                Notify when resolved
              </label>
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={createMutation.isPending || updateMutation.isPending}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {editingId ? 'Update' : 'Save'}
              </button>
              <button type="button" onClick={closeForm} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {!channels?.length ? (
          <div className="flex flex-col items-center py-12 text-muted-foreground">
            <BellRing size={36} className="mb-3 opacity-30" />
            <p className="text-sm">No channels yet — alerts stay in the dashboard.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {channels.map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                {c.type === 'slack' ? <Hash size={16} className="text-muted-foreground" /> : <Webhook size={16} className="text-muted-foreground" />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium flex items-center gap-2">
                    {c.name}
                    {!c.enabled && <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Disabled</span>}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    <span className="font-mono">{c.targetHint}</span>
                    {' · '}
                    {c.minSeverity === 'critical' ? 'critical only' : 'warning and above'}
                    {c.notifyOnResolve ? ' · notifies on resolve' : ''}
                  </p>
                  {c.lastStatus && (
                    <p className={`mt-0.5 flex items-center gap-1 text-xs ${c.lastStatus === 'ok' ? 'text-emerald-500' : 'text-red-500'}`}>
                      {c.lastStatus === 'ok' ? <CircleCheck size={11} /> : <CircleAlert size={11} />}
                      {c.lastStatus === 'ok'
                        ? `Last delivery OK${c.lastSentAt ? ` · ${new Date(c.lastSentAt).toLocaleString()}` : ''}`
                        : `Last delivery failed: ${c.lastError ?? 'unknown error'}`}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => toggleMutation.mutate({ id: c.id, enabled: !c.enabled })}
                  className="text-xs text-muted-foreground hover:text-foreground mr-1"
                  title={c.enabled ? 'Disable' : 'Enable'}
                >
                  {c.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  onClick={() => testMutation.mutate(c.id)}
                  disabled={testMutation.isPending}
                  className="text-muted-foreground hover:text-foreground mr-1 disabled:opacity-50"
                  title="Send test notification"
                >
                  <Send size={14} />
                </button>
                <button onClick={() => openEdit(c)} className="text-muted-foreground hover:text-foreground mr-1" title="Edit">
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => { if (confirm(`Remove ${c.name}?`)) deleteMutation.mutate(c.id); }}
                  className="text-red-500 hover:text-red-600"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
