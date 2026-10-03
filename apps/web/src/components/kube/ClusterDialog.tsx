import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Agent,
  KubeCluster,
  KubeClusterInput,
  KubeConnectVia,
  KubeTestResult,
  KubeconfigSummary,
  Server,
} from '@smt/shared';
import { FileUp, Loader2, PlugZap, ShipWheel, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { kubeKeys } from '@/lib/kube.js';
import TestResult from './TestResult.js';

type Source = 'kubeconfig' | 'fields';

const VIA_OPTIONS: { value: KubeConnectVia; label: string; hint: string }[] = [
  { value: 'direct', label: 'Directly', hint: 'This app can reach the API server URL.' },
  { value: 'server', label: 'Through a server', hint: 'Tunnel over SSH via a server already in BastionSSH (a control-plane node or bastion).' },
  { value: 'agent', label: 'Through an agent', hint: 'The agent must run on a control-plane node and allow the API port (usually 6443).' },
];

const input =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';
const mono = cn(input, 'font-mono text-xs');

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/**
 * Add or edit a cluster (admins). The connection comes from an uploaded
 * kubeconfig — every context is listed, with the reason when one cannot be
 * used (exec plugins, insecure TLS…) — or from the fields. Saved credentials
 * are never sent back: editing shows a hint ("token ending …abcd") and
 * leaves them alone unless new ones are entered. "Test" runs the same checks
 * the server will, without saving, and shows what the credential may do.
 */
export default function ClusterDialog({ cluster, onClose }: { cluster: KubeCluster | null; onClose: () => void }) {
  const qc = useQueryClient();
  const editing = !!cluster;
  const [source, setSource] = useState<Source>(editing ? 'fields' : 'kubeconfig');
  const [name, setName] = useState(cluster?.name ?? '');
  const [kubeconfig, setKubeconfig] = useState('');
  const [summary, setSummary] = useState<KubeconfigSummary | null>(null);
  const [context, setContext] = useState('');
  const [apiUrl, setApiUrl] = useState(cluster?.apiUrl ?? '');
  // Editing: the saved CA stays unless replaced ('' then means the system trust store)
  const [replaceCa, setReplaceCa] = useState(!editing);
  const [caData, setCaData] = useState('');
  const [authType, setAuthType] = useState(cluster?.authType ?? 'token');
  const [token, setToken] = useState('');
  const [clientCert, setClientCert] = useState('');
  const [clientKey, setClientKey] = useState('');
  const [connectVia, setConnectVia] = useState<KubeConnectVia>(cluster?.connectVia ?? 'direct');
  const [viaServerId, setViaServerId] = useState(cluster?.viaServerId ?? '');
  const [viaAgentId, setViaAgentId] = useState(cluster?.viaAgentId ?? '');
  const [defaultNamespace, setDefaultNamespace] = useState(cluster?.defaultNamespace ?? 'default');
  const [allowlist, setAllowlist] = useState((cluster?.namespacesAllowlist ?? []).join(', '));
  const [impersonate, setImpersonate] = useState(cluster?.impersonate ?? false);
  const [test, setTest] = useState<KubeTestResult | null>(null);

  const servers = useQuery<Server[]>({ queryKey: ['servers'], queryFn: () => api.get('/servers'), enabled: connectVia === 'server' });
  const agents = useQuery<Agent[]>({ queryKey: ['agents'], queryFn: () => api.get('/agents'), enabled: connectVia === 'agent' });

  const inspect = useMutation({
    mutationFn: (text: string) => api.post<KubeconfigSummary>('/kube/kubeconfig/contexts', { kubeconfig: text }),
    onSuccess: (res) => {
      setSummary(res);
      const usable = res.contexts.filter((c) => !c.problem);
      const pick = usable.find((c) => c.name === res.currentContext) ?? usable[0];
      if (pick) choose(pick.name, res);
      else setContext('');
    },
    onError: (err: Error) => {
      setSummary(null);
      toast.error(err.message);
    },
  });

  function choose(ctxName: string, from = summary) {
    setContext(ctxName);
    setTest(null);
    const ctx = from?.contexts.find((c) => c.name === ctxName);
    if (!ctx) return;
    if (!name.trim() || name === context) setName(ctxName);
    if (ctx.namespace) setDefaultNamespace(ctx.namespace);
  }

  async function readFile(file: File) {
    const text = await file.text();
    setKubeconfig(text);
    inspect.mutate(text);
  }

  function body(): KubeClusterInput {
    const namespaces = allowlist
      .split(/[\s,]+/)
      .map((n) => n.trim())
      .filter(Boolean);
    const out: KubeClusterInput = {
      name: name.trim() || undefined,
      connectVia,
      viaServerId: connectVia === 'server' ? viaServerId || null : null,
      viaAgentId: connectVia === 'agent' ? viaAgentId || null : null,
      impersonate,
      defaultNamespace: defaultNamespace.trim() || 'default',
      namespacesAllowlist: namespaces.length ? namespaces : null,
    };
    if (source === 'kubeconfig') return { ...out, kubeconfig, context: context || undefined };
    if (!editing || apiUrl !== cluster.apiUrl) out.apiUrl = apiUrl.trim();
    if (replaceCa && (editing || caData.trim())) out.caData = caData;
    if (authType === 'token' && token.trim()) out.token = token.trim();
    if (authType === 'cert' && (clientCert.trim() || clientKey.trim())) {
      out.clientCert = clientCert;
      out.clientKey = clientKey;
    }
    return out;
  }

  const runTest = useMutation({
    mutationFn: () => api.post<KubeTestResult>(editing ? `/kube/clusters/${cluster.id}/test` : '/kube/clusters/test', body()),
    onSuccess: setTest,
    onError: (err: Error) => {
      setTest(null);
      toast.error(err.message);
    },
  });

  const save = useMutation({
    mutationFn: () => (editing ? api.patch<KubeCluster>(`/kube/clusters/${cluster.id}`, body()) : api.post<KubeCluster>('/kube/clusters', body())),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: kubeKeys.clusters });
      qc.invalidateQueries({ queryKey: ['kube', saved.id] });
      toast.success(editing ? 'Cluster saved' : `${saved.name} added`);
      onClose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const ready =
    source === 'kubeconfig'
      ? !!kubeconfig && !!context
      : !!apiUrl.trim() && (editing || (authType === 'token' ? !!token.trim() : !!clientCert.trim() && !!clientKey.trim()));
  const routeReady = connectVia === 'direct' || (connectVia === 'server' ? !!viaServerId : !!viaAgentId);
  const busy = runTest.isPending || save.isPending;
  // Anything edited makes the last test stale
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setTest(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cluster-dialog-title"
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <ShipWheel size={16} className="shrink-0 text-primary" />
          <span id="cluster-dialog-title" className="flex-1 truncate text-sm font-semibold">
            {editing ? `Edit ${cluster.name}` : 'Add a Kubernetes cluster'}
          </span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div className="flex gap-1 rounded-md bg-muted p-1 text-sm" role="tablist">
            {(['kubeconfig', 'fields'] as Source[]).map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={source === s}
                onClick={() => edit(setSource)(s)}
                className={cn('flex-1 rounded px-3 py-1.5', source === s ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground')}
              >
                {s === 'kubeconfig' ? (editing ? 'Replace from a kubeconfig' : 'Upload a kubeconfig') : editing ? 'Connection' : 'Enter details'}
              </button>
            ))}
          </div>

          {source === 'kubeconfig' ? (
            <div className="space-y-3">
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border px-4 py-5 text-sm text-muted-foreground hover:bg-muted/50">
                <FileUp size={16} />
                {kubeconfig ? 'Choose another file' : 'Choose a kubeconfig file'}
                <input
                  type="file"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void readFile(file);
                    e.target.value = '';
                  }}
                />
              </label>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">…or paste it</summary>
                <textarea
                  value={kubeconfig}
                  onChange={(e) => {
                    setKubeconfig(e.target.value);
                    setSummary(null);
                    setTest(null);
                  }}
                  onBlur={() => kubeconfig.trim() && !summary && inspect.mutate(kubeconfig)}
                  rows={6}
                  spellCheck={false}
                  className={cn(mono, 'mt-2')}
                  placeholder="apiVersion: v1&#10;kind: Config&#10;…"
                />
              </details>
              <p className="text-xs text-muted-foreground">
                Only the picked context’s server, CA and credential are kept, encrypted. Contexts that run a program to sign in (exec
                plugins, auth providers) or skip TLS verification are refused — use a service account token instead.
              </p>
              {inspect.isPending && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" /> Reading the kubeconfig…
                </p>
              )}
              {summary && (
                <div className="divide-y divide-border rounded-md border border-border" data-testid="kubeconfig-contexts">
                  {summary.contexts.length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">No contexts in this file.</p>}
                  {summary.contexts.map((c) => (
                    <label
                      key={c.name}
                      className={cn('flex items-start gap-2 px-3 py-2 text-sm', c.problem ? 'opacity-70' : 'cursor-pointer hover:bg-muted/50')}
                    >
                      <input
                        type="radio"
                        className="mt-1"
                        disabled={!!c.problem}
                        checked={context === c.name}
                        onChange={() => choose(c.name)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{c.name}</span>
                        {c.name === summary.currentContext && <span className="ml-2 text-xs text-muted-foreground">current</span>}
                        <span className="block truncate font-mono text-xs text-muted-foreground">{c.server ?? 'no server'}</span>
                        {c.problem ? (
                          <span className="block text-xs text-red-600">{c.problem}</span>
                        ) : (
                          <span className="block text-xs text-muted-foreground">
                            {c.authType === 'cert' ? 'client certificate' : 'token'} · {c.hasCa ? 'pinned CA' : 'system trust store'}
                            {c.namespace && ` · namespace ${c.namespace}`}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <Field label="Name">
                <input value={name} onChange={(e) => setName(e.target.value)} className={input} placeholder="production" />
              </Field>
            </div>
          ) : (
            <div className="space-y-3">
              <Field label="Name">
                <input value={name} onChange={(e) => setName(e.target.value)} className={input} placeholder="production" />
              </Field>
              <Field label="API server URL" hint="As in the kubeconfig’s server: field. Its hostname is what the certificate is checked against.">
                <input value={apiUrl} onChange={(e) => edit(setApiUrl)(e.target.value)} className={mono} placeholder="https://10.0.0.10:6443" />
              </Field>
              {editing && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={replaceCa} onChange={(e) => edit(setReplaceCa)(e.target.checked)} />
                  Replace the cluster CA <span className="text-xs text-muted-foreground">({cluster.hasCa ? 'a CA is pinned' : 'system trust store'})</span>
                </label>
              )}
              {replaceCa && (
                <Field label="Cluster CA (PEM)" hint="Leave empty to trust the system’s certificate authorities (managed clusters with public certificates).">
                  <textarea value={caData} onChange={(e) => edit(setCaData)(e.target.value)} rows={3} spellCheck={false} className={mono} placeholder="-----BEGIN CERTIFICATE-----" />
                </Field>
              )}
              <div className="space-y-1">
                <span className="text-sm font-medium">Credential</span>
                {editing && (
                  <p className="text-xs text-muted-foreground">
                    {apiUrl.trim() !== cluster.apiUrl || replaceCa
                      ? 'A new address or CA needs the credential again: the saved one is only sent to the server it was saved for.'
                      : `Saved: ${cluster.credentialHint}. Enter a new one only to replace it.`}
                  </p>
                )}
                <div className="flex gap-4 text-sm">
                  {(['token', 'cert'] as const).map((t) => (
                    <label key={t} className="flex items-center gap-1.5">
                      <input type="radio" checked={authType === t} onChange={() => edit(setAuthType)(t)} />
                      {t === 'token' ? 'Service account token' : 'Client certificate'}
                    </label>
                  ))}
                </div>
              </div>
              {authType === 'token' ? (
                <textarea
                  value={token}
                  onChange={(e) => edit(setToken)(e.target.value)}
                  rows={2}
                  spellCheck={false}
                  autoComplete="off"
                  className={mono}
                  placeholder={editing ? 'unchanged' : 'eyJhbGciOi…'}
                />
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  <textarea value={clientCert} onChange={(e) => edit(setClientCert)(e.target.value)} rows={3} spellCheck={false} className={mono} placeholder="Certificate (PEM)" />
                  <textarea value={clientKey} onChange={(e) => edit(setClientKey)(e.target.value)} rows={3} spellCheck={false} autoComplete="off" className={mono} placeholder="Private key (PEM)" />
                </div>
              )}
            </div>
          )}

          <div className="space-y-2 border-t border-border pt-4">
            <span className="text-sm font-medium">Connect</span>
            <div className="grid gap-2 sm:grid-cols-3">
              {VIA_OPTIONS.map((o) => (
                <label
                  key={o.value}
                  title={o.hint}
                  className={cn(
                    'flex cursor-pointer flex-col rounded-md border px-3 py-2 text-sm',
                    connectVia === o.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <input type="radio" checked={connectVia === o.value} onChange={() => edit(setConnectVia)(o.value)} />
                    {o.label}
                  </span>
                  <span className="mt-1 text-xs text-muted-foreground">{o.hint}</span>
                </label>
              ))}
            </div>
            {connectVia === 'server' && (
              <select value={viaServerId} onChange={(e) => edit(setViaServerId)(e.target.value)} className={input}>
                <option value="">Pick a server…</option>
                {servers.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.host})
                  </option>
                ))}
              </select>
            )}
            {connectVia === 'agent' && (
              <select value={viaAgentId} onChange={(e) => edit(setViaAgentId)(e.target.value)} className={input}>
                <option value="">Pick an agent…</option>
                {agents.data
                  ?.filter((a) => a.status !== 'revoked')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.status})
                    </option>
                  ))}
              </select>
            )}
          </div>

          <details className="border-t border-border pt-4" open={editing}>
            <summary className="cursor-pointer text-sm font-medium">Namespaces and identity</summary>
            <div className="mt-3 space-y-3">
              <Field label="Default namespace" hint="Where capability checks run, and the namespace offered when nothing else is listable.">
                <input value={defaultNamespace} onChange={(e) => edit(setDefaultNamespace)(e.target.value)} className={mono} />
              </Field>
              <Field label="Only these namespaces" hint="Comma-separated. Nobody in this org sees other namespaces on this cluster. Empty = all.">
                <input value={allowlist} onChange={(e) => edit(setAllowlist)(e.target.value)} className={mono} placeholder="shop, payments" />
              </Field>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={impersonate} onChange={(e) => edit(setImpersonate)(e.target.checked)} />
                <span>
                  Act as each member
                  <span className="block text-xs text-muted-foreground">
                    Requests carry Impersonate-User bastion:&lt;email&gt; and Impersonate-Group bastion:&lt;role&gt;, so Kubernetes RBAC
                    and its audit log see the real person. The credential needs the impersonate permission.
                  </span>
                </span>
              </label>
            </div>
          </details>

          {test && <TestResult result={test} />}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={() => runTest.mutate()}
            disabled={busy || !ready || !routeReady}
            className="mr-auto flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            {runTest.isPending ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />} Test connection
          </button>
          <button onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
            Cancel
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={busy || !ready || !routeReady}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : editing ? 'Save' : 'Add cluster'}
          </button>
        </div>
      </div>
    </div>
  );
}
