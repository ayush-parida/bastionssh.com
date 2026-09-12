import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import {
  CHANNEL_TYPES,
  channelMeta,
  type ChannelField,
  type ChannelGroup,
  type CreateNotificationChannelRequest,
  type NotificationCapabilities,
  type NotificationChannel,
  type NotificationChannelType,
  type NotificationTestResult,
  type UpdateNotificationChannelRequest,
} from '@smt/shared';
import {
  Plus,
  Trash2,
  Pencil,
  Send,
  BellRing,
  Webhook,
  Mail,
  MessageSquare,
  Siren,
  Smartphone,
  CircleAlert,
  CircleCheck,
} from 'lucide-react';
import { toast } from 'sonner';

/** Every possible input, as strings; only the type's own fields are rendered and sent. */
interface ChannelForm {
  name: string;
  type: NotificationChannelType;
  url: string;
  recipients: string;
  token: string;
  chatId: string;
  userKey: string;
  routingKey: string;
  region: 'us' | 'eu';
  minSeverity: 'warning' | 'critical';
  notifyOnResolve: boolean;
}

const emptyForm: ChannelForm = {
  name: '',
  type: 'slack',
  url: '',
  recipients: '',
  token: '',
  chatId: '',
  userKey: '',
  routingKey: '',
  region: 'us',
  minSeverity: 'warning',
  notifyOnResolve: true,
};

const GROUP_LABEL: Record<ChannelGroup, string> = {
  chat: 'Chat',
  paging: 'On-call paging',
  push: 'Push notifications',
  other: 'Other',
};

const GROUP_ICON: Record<ChannelGroup, typeof Webhook> = {
  chat: MessageSquare,
  paging: Siren,
  push: Smartphone,
  other: Webhook,
};

const FIELD_LABEL: Record<ChannelField, string> = {
  url: 'URL',
  recipients: 'Recipients',
  token: 'Token',
  chatId: 'Chat id',
  userKey: 'User key',
  routingKey: 'Integration key',
  region: 'Region',
};

const SECRET_FIELDS = new Set<ChannelField>(['token', 'userKey', 'routingKey']);

const QUERY_KEY = ['notification-channels'];

const inputClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

function splitList(input: string): string[] {
  return [...new Set(input.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * Only the type's own fields are sent, and only when filled in — on edit a
 * blank set means "keep the stored target", which is never returned to us.
 */
function targetFields(form: ChannelForm): Partial<CreateNotificationChannelRequest> {
  const out: Partial<CreateNotificationChannelRequest> = {};
  const fields = channelMeta(form.type).fields;
  const filled = fields.filter((f) => f !== 'region' && form[f].trim() !== '');
  if (filled.length === 0) return out;
  for (const field of fields) {
    if (field === 'recipients') out.recipients = splitList(form.recipients);
    else if (field === 'region') out.region = form.region;
    else if (form[field].trim()) out[field] = form[field].trim();
  }
  return out;
}

export default function NotificationChannels() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ChannelForm>(emptyForm);

  const { data: channels } = useQuery<NotificationChannel[]>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/notifications/channels'),
  });

  const { data: caps } = useQuery<NotificationCapabilities>({
    queryKey: ['notification-capabilities'],
    queryFn: () => api.get('/notifications/capabilities'),
    staleTime: 5 * 60_000,
  });
  const emailOn = caps?.email ?? false;

  const invalidate = () => qc.invalidateQueries({ queryKey: QUERY_KEY });

  const createMutation = useMutation({
    mutationFn: (body: ChannelForm) => {
      const payload: CreateNotificationChannelRequest = {
        name: body.name,
        type: body.type,
        minSeverity: body.minSeverity,
        notifyOnResolve: body.notifyOnResolve,
        ...targetFields(body),
      };
      return api.post('/notifications/channels', payload);
    },
    onSuccess: () => { invalidate(); closeForm(); toast.success('Channel added'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: ChannelForm }) => {
      const payload: UpdateNotificationChannelRequest = {
        name: body.name,
        minSeverity: body.minSeverity,
        notifyOnResolve: body.notifyOnResolve,
        ...targetFields(body),
      };
      return api.patch(`/notifications/channels/${id}`, payload);
    },
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
      ...emptyForm,
      name: channel.name,
      type: channel.type,
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

  const meta = channelMeta(form.type);
  const groups = (['chat', 'paging', 'push', 'other'] as const).map((g) => ({
    group: g,
    types: CHANNEL_TYPES.filter((m) => m.group === g),
  }));

  function renderField(field: ChannelField) {
    if (field === 'recipients') {
      return (
        <div key={field} className="col-span-2">
          <label className="block text-sm font-medium mb-1">Recipients</label>
          <textarea
            required={!editingId}
            rows={2}
            value={form.recipients}
            onChange={(e) => setForm((p) => ({ ...p, recipients: e.target.value }))}
            placeholder="ops@example.com, oncall@example.com"
            className={`${inputClass} font-mono`}
          />
        </div>
      );
    }
    if (field === 'region') {
      return (
        <div key={field}>
          <label className="block text-sm font-medium mb-1">Region</label>
          <select
            value={form.region}
            onChange={(e) => setForm((p) => ({ ...p, region: e.target.value as 'us' | 'eu' }))}
            className={inputClass}
          >
            <option value="us">US (api.opsgenie.com)</option>
            <option value="eu">EU (api.eu.opsgenie.com)</option>
          </select>
        </div>
      );
    }
    const wide = field === 'url' || meta.fields.length === 1;
    return (
      <div key={field} className={wide ? 'col-span-2' : ''}>
        <label className="block text-sm font-medium mb-1">{FIELD_LABEL[field]}</label>
        <input
          type={field === 'url' ? 'url' : SECRET_FIELDS.has(field) ? 'password' : 'text'}
          required={!editingId}
          autoComplete={SECRET_FIELDS.has(field) ? 'new-password' : 'off'}
          value={form[field]}
          onChange={(e) => setForm((p) => ({ ...p, [field]: e.target.value }))}
          placeholder={field === 'url' ? meta.urlPlaceholder : undefined}
          className={`${inputClass} font-mono`}
        />
      </div>
    );
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
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Type</label>
                <select
                  value={form.type}
                  disabled={editingId !== null}
                  onChange={(e) => setForm((p) => ({ ...p, type: e.target.value as NotificationChannelType }))}
                  className={`${inputClass} disabled:opacity-50`}
                >
                  {groups.map(({ group, types }) => (
                    <optgroup key={group} label={GROUP_LABEL[group]}>
                      {types.map((t) => (
                        <option key={t.type} value={t.type} disabled={t.type === 'email' && !emailOn}>
                          {t.label}
                          {t.type === 'email' && !emailOn ? ' (SMTP not configured)' : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              {meta.fields.map(renderField)}
            </div>
            <p className="text-xs text-muted-foreground">
              {meta.help}
              {editingId ? ' Leave the credential fields blank to keep the existing ones.' : ''}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Send when</label>
                <select
                  value={form.minSeverity}
                  onChange={(e) => setForm((p) => ({ ...p, minSeverity: e.target.value as ChannelForm['minSeverity'] }))}
                  className={inputClass}
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
            {channels.map((c) => {
              const m = channelMeta(c.type);
              const Icon = c.type === 'email' ? Mail : GROUP_ICON[m.group];
              return (
                <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                  <Icon size={16} className="text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium flex items-center gap-2">
                      {c.name}
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">{m.label}</span>
                      {!c.enabled && <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">Disabled</span>}
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
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
