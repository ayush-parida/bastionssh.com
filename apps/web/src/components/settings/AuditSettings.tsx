import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { relativeTime } from '@/lib/utils.js';
import { isPasskeyCancel, passkeyErrorMessage, withStepUp } from '@/lib/passkeys.js';
import { useIsOwner } from '@/hooks/useModules.js';
import type { AuditForwardingInfo, AuditForwardingInput, AuditSettings as Settings, SyslogProtocol } from '@smt/shared';
import { Archive, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

const DEFAULT_PORTS: Record<SyslogProtocol, number> = { udp: 514, tcp: 514, tls: 6514 };

interface ForwardForm {
  type: 'syslog' | 'webhook';
  host: string;
  port: string;
  protocol: SyslogProtocol;
  facility: string;
  caCert: string;
  url: string;
  secret: string;
  enabled: boolean;
}

function formFrom(f: AuditForwardingInfo | null): ForwardForm {
  return {
    type: f?.type ?? 'syslog',
    host: f?.syslog?.host ?? '',
    port: String(f?.syslog?.port ?? 6514),
    protocol: f?.syslog?.protocol ?? 'tls',
    facility: String(f?.syslog?.facility ?? 13),
    caCert: '',
    url: '',
    secret: '',
    enabled: f?.enabled ?? true,
  };
}

const input =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

function onError(err: Error) {
  if (!isPasskeyCancel(err)) toast.error(passkeyErrorMessage(err));
}

/** Retention and forwarding for the org's audit log. Admins see it; owners change it. */
export default function AuditSettings() {
  const qc = useQueryClient();
  const isOwner = useIsOwner();
  const [retention, setRetention] = useState('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ForwardForm>(formFrom(null));

  const { data: settings } = useQuery<Settings>({
    queryKey: ['audit-settings'],
    queryFn: () => api.get('/audit/settings'),
  });

  useEffect(() => {
    if (settings) setRetention(String(settings.retentionDays));
  }, [settings]);

  const retentionMutation = useMutation({
    // Shortening retention deletes history, so it asks for a passkey when there is one
    mutationFn: (days: number) => withStepUp(() => api.put('/audit/settings/retention', { retentionDays: days })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['audit-settings'] });
      toast.success('Retention updated');
    },
    onError,
  });

  const saveMutation = useMutation({
    mutationFn: (body: AuditForwardingInput) =>
      withStepUp(() => api.put<AuditForwardingInfo>('/audit/forwarding', body)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['audit-settings'] });
      setEditing(false);
      toast.success('Audit forwarding saved');
    },
    onError,
  });

  const deleteMutation = useMutation({
    mutationFn: () => withStepUp(() => api.delete('/audit/forwarding')),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['audit-settings'] });
      toast.success('Audit forwarding removed');
    },
    onError,
  });

  const testMutation = useMutation({
    mutationFn: () => api.post('/audit/forwarding/test'),
    onSuccess: () => toast.success('Test event delivered'),
    onError: (err: Error) => toast.error(err.message),
  });

  if (!settings) return null;
  const fwd = settings.forwarding;

  function save(e: React.FormEvent) {
    e.preventDefault();
    const body: AuditForwardingInput =
      form.type === 'syslog'
        ? {
            type: 'syslog',
            host: form.host,
            port: Number(form.port),
            protocol: form.protocol,
            facility: Number(form.facility),
            enabled: form.enabled,
            // Blank keeps the stored CA bundle
            ...(form.caCert.trim() && { caCert: form.caCert }),
          }
        : {
            type: 'webhook',
            enabled: form.enabled,
            // Blank keeps the stored URL and secret
            ...(form.url.trim() && { url: form.url.trim() }),
            ...(form.secret && { secret: form.secret }),
          };
    saveMutation.mutate(body);
  }

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold mb-1">Retention &amp; forwarding</h2>
      <p className="text-sm text-muted-foreground mb-4">
        How long audit events are kept, and where new ones are copied as they happen.
      </p>

      <div className="rounded-lg border border-border bg-card divide-y divide-border">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <Archive size={16} className="text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-[12rem]">
            <p className="text-sm font-medium">Keep events for</p>
            <p className="text-xs text-muted-foreground">Older events are deleted once a day. 7–3650 days.</p>
          </div>
          {isOwner ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const days = Number(retention);
                if (days < settings.retentionDays && !confirm(`Events older than ${days} days will be deleted at the next daily prune. Continue?`)) return;
                retentionMutation.mutate(days);
              }}
            >
              <input
                type="number"
                min={7}
                max={3650}
                required
                value={retention}
                onChange={(e) => setRetention(e.target.value)}
                className="w-24 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              />
              <span className="text-sm text-muted-foreground">days</span>
              <button
                type="submit"
                disabled={retentionMutation.isPending || retention === String(settings.retentionDays)}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              >
                Save
              </button>
            </form>
          ) : (
            <span className="text-sm">{settings.retentionDays} days</span>
          )}
        </div>

        <div className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <Send size={16} className="text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-[12rem]">
              <p className="text-sm font-medium">Forwarding</p>
              {fwd ? (
                <p className="text-xs text-muted-foreground break-all">
                  {fwd.type === 'syslog' ? 'Syslog' : 'Webhook'} · {fwd.targetHint}
                  {!fwd.enabled && ' · paused'}
                  {fwd.lastStatus === 'ok' && fwd.lastSentAt && ` · last delivered ${relativeTime(fwd.lastSentAt)}`}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Not configured.</p>
              )}
              {fwd?.lastStatus === 'failed' && (
                <p className="text-xs text-red-500 mt-1 break-all">Failing: {fwd.lastError}</p>
              )}
            </div>
            {isOwner && !editing && (
              <div className="flex items-center gap-2">
                {fwd && (
                  <button
                    onClick={() => testMutation.mutate()}
                    disabled={testMutation.isPending}
                    className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                  >
                    Send test
                  </button>
                )}
                <button
                  onClick={() => { setForm(formFrom(fwd)); setEditing(true); }}
                  className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  {fwd ? 'Edit' : 'Set up'}
                </button>
                {fwd && (
                  <button
                    onClick={() => { if (confirm('Stop forwarding audit events?')) deleteMutation.mutate(); }}
                    className="text-red-500 hover:text-red-600"
                    title="Remove forwarding"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            )}
          </div>

          {editing && (
            <form onSubmit={save} className="mt-4 space-y-3">
              <div className="flex gap-2">
                {(['syslog', 'webhook'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, type: t }))}
                    className={`rounded-md border px-3 py-1.5 text-sm ${form.type === t ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted'}`}
                  >
                    {t === 'syslog' ? 'Syslog (RFC 5424)' : 'Webhook'}
                  </button>
                ))}
              </div>

              {form.type === 'syslog' ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr_7rem_7rem] gap-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">Host</label>
                      <input required value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} className={input} placeholder="logs.example.com" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Protocol</label>
                      <select
                        value={form.protocol}
                        onChange={(e) => {
                          const protocol = e.target.value as SyslogProtocol;
                          setForm((f) => ({ ...f, protocol, port: String(DEFAULT_PORTS[protocol]) }));
                        }}
                        className={input}
                      >
                        <option value="tls">TLS</option>
                        <option value="tcp">TCP</option>
                        <option value="udp">UDP</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Port</label>
                      <input type="number" required min={1} max={65535} value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} className={input} />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Facility</label>
                    <input type="number" min={0} max={23} value={form.facility} onChange={(e) => setForm((f) => ({ ...f, facility: e.target.value }))} className="w-24 rounded-md border border-input bg-background px-3 py-2 text-sm" />
                    <span className="ml-2 text-xs text-muted-foreground">13 = log audit</span>
                  </div>
                  {form.protocol === 'tls' && (
                    <div>
                      <label className="block text-sm font-medium mb-1">CA certificate (optional)</label>
                      <textarea
                        rows={3}
                        value={form.caCert}
                        onChange={(e) => setForm((f) => ({ ...f, caCert: e.target.value }))}
                        className={`${input} font-mono text-xs`}
                        placeholder={fwd?.syslog?.hasCaCert ? 'Leave blank to keep the current CA bundle' : '-----BEGIN CERTIFICATE-----'}
                      />
                      <p className="text-xs text-muted-foreground mt-1">Only needed for a private CA; public certificates are trusted already.</p>
                    </div>
                  )}
                  {form.protocol !== 'tls' && (
                    <p className="text-xs text-amber-600">UDP and TCP send events unencrypted. Use TLS unless the collector is on a trusted network.</p>
                  )}
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-1">URL</label>
                    <input
                      type="url"
                      required={fwd?.type !== 'webhook'}
                      value={form.url}
                      onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                      className={input}
                      placeholder={fwd?.type === 'webhook' ? 'Leave blank to keep the current URL' : 'https://siem.example.com/ingest'}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Signing secret (optional)</label>
                    <input
                      type="password"
                      value={form.secret}
                      onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
                      className={input}
                      placeholder={fwd?.webhook?.hasSecret ? 'Leave blank to keep the current secret' : ''}
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Each POST carries <code>X-BastionSSH-Signature: sha256=HMAC(secret, timestamp + "." + body)</code> and <code>X-BastionSSH-Timestamp</code>.
                    </p>
                  </div>
                </>
              )}

              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
                Forward new events
              </label>
              <p className="text-xs text-muted-foreground">
                Targets must be public addresses unless the operator allowed a network with SMT_AUDIT_FORWARD_ALLOW_NETS. Only events from now on are sent.
              </p>
              <div className="flex gap-2">
                <button type="submit" disabled={saveMutation.isPending} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  Save
                </button>
                <button type="button" onClick={() => setEditing(false)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
