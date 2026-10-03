import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { KubeConfigItem, KubeConfigView } from '@smt/shared';
import { AlertOctagon, FileCog, KeyRound, Loader2, Lock, Search } from 'lucide-react';
import { api } from '@/lib/api.js';
import { kubeKeys, kubePath, useKubeChanges } from '@/lib/kube.js';
import UsedBy, { ObjectChip } from './UsedBy.js';

/**
 * Config (spec §5.5): ConfigMaps (settings) and Secrets (passwords, keys,
 * certificates) by name and key — Secret values never reach the browser —
 * with the workloads that read each one, as files or environment variables.
 * A reference to one that does not exist comes first, in red: its pods
 * cannot start. Kubernetes' own (the CA bundle in every namespace, Helm's
 * release records, service-account tokens) are hidden unless asked for. Live.
 */

/** Created and read by Kubernetes or Helm themselves: noise next to the apps' own. */
function isSystem(item: KubeConfigItem): boolean {
  if (item.ref.kind === 'ConfigMap') return item.ref.name === 'kube-root-ca.crt';
  return item.type === 'kubernetes.io/service-account-token' || item.type === 'helm.sh/release.v1';
}

/** Secret types in words; the plain kind (`Opaque`) needs none. */
const SECRET_TYPE: Record<string, string> = {
  Opaque: '',
  'kubernetes.io/tls': 'TLS certificate',
  'kubernetes.io/dockerconfigjson': 'registry login',
  'kubernetes.io/dockercfg': 'registry login',
  'kubernetes.io/basic-auth': 'username and password',
  'kubernetes.io/ssh-auth': 'SSH key',
  'kubernetes.io/service-account-token': 'service account token',
  'helm.sh/release.v1': 'Helm release record',
};

function ConfigRow({ clusterId, item }: { clusterId: string; item: KubeConfigItem }) {
  const secret = item.ref.kind === 'Secret';
  return (
    <li className="space-y-1.5 rounded-md border border-border bg-card px-3 py-2.5" data-testid="config-item" data-kind={item.ref.kind}>
      <div className="flex flex-wrap items-center gap-2">
        {secret ? <KeyRound size={14} className="shrink-0 text-muted-foreground" /> : <FileCog size={14} className="shrink-0 text-muted-foreground" />}
        <ObjectChip clusterId={clusterId} objectRef={item.ref} fromTab="config" className="bg-transparent px-0 text-sm" />
        {secret && (SECRET_TYPE[item.type ?? ''] ?? item.type) && <span className="text-xs text-muted-foreground">{SECRET_TYPE[item.type ?? ''] ?? item.type}</span>}
      </div>
      {item.keys.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {item.keys.map((k) => (
            <code key={k} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              {secret && <Lock size={9} className="text-muted-foreground" aria-hidden />}
              {k}
            </code>
          ))}
          {secret && <span className="text-[11px] text-muted-foreground">values are never shown</span>}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No keys.</p>
      )}
      <UsedBy clusterId={clusterId} consumers={item.usedBy} fromTab="config" none="No workload here reads it." />
    </li>
  );
}

function Section({ title, hint, clusterId, items }: { title: string; hint: string; clusterId: string; items: KubeConfigItem[] }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium">
          {title} <span className="font-normal text-muted-foreground">{items.length}</span>
        </h2>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {items.length ? (
        <ul className="grid gap-2 lg:grid-cols-2">
          {items.map((i) => (
            <ConfigRow key={`${i.ref.namespace}/${i.ref.name}`} clusterId={clusterId} item={i} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">None.</p>
      )}
    </section>
  );
}

export default function ConfigTab({ clusterId, namespace }: { clusterId: string; namespace: string }) {
  const [filter, setFilter] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const ns = namespace || null;
  const key = kubeKeys.config(clusterId, ns);
  const config = useQuery<KubeConfigView>({
    queryKey: key,
    queryFn: () => api.get(kubePath(clusterId, `/config${ns ? `?namespace=${encodeURIComponent(ns)}` : ''}`)),
    retry: false,
  });
  useKubeChanges(clusterId, 'config', { namespace: ns }, key, config.isSuccess);

  const [configMaps, secrets, hidden] = useMemo(() => {
    const words = filter.trim().toLowerCase();
    const keep = (i: KubeConfigItem) =>
      (showSystem || !isSystem(i)) &&
      (!words || `${i.ref.namespace ?? ''}/${i.ref.name} ${i.keys.join(' ')} ${i.usedBy.map((u) => u.ref.name).join(' ')}`.toLowerCase().includes(words));
    const all = [...(config.data?.configMaps ?? []), ...(config.data?.secrets ?? [])];
    return [config.data?.configMaps.filter(keep) ?? [], config.data?.secrets.filter(keep) ?? [], all.filter(isSystem).length];
  }, [config.data, filter, showSystem]);

  if (config.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" /> Reading config…
      </p>
    );
  }
  if (config.error) return <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(config.error as Error).message}</p>;
  const v = config.data!;

  return (
    <div className="space-y-5">
      {v.warnings.map((w) => (
        <p key={w} className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          {w}
        </p>
      ))}

      {v.missing.length > 0 && (
        <section className="space-y-2 rounded-lg border border-red-500/50 bg-red-500/5 p-3" data-testid="config-missing">
          <p className="flex items-center gap-2 text-sm font-medium text-red-600">
            <AlertOctagon size={15} /> {v.missing.length} missing — the pods that need {v.missing.length === 1 ? 'it' : 'them'} cannot start
          </p>
          <ul className="space-y-1.5">
            {v.missing.map((m) => (
              <li key={`${m.kind}/${m.namespace}/${m.name}`} className="space-y-1 text-sm">
                <p>
                  {m.kind} <code className="rounded bg-muted px-1 font-mono text-[0.85em]">{m.name}</code>
                  {m.namespace && <span className="text-muted-foreground"> in {m.namespace}</span>} does not exist.
                </p>
                <UsedBy clusterId={clusterId} consumers={m.usedBy} fromTab="config" none="" />
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-[12rem] flex-1 items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5 text-sm">
          <Search size={14} className="text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, key or workload"
            className="w-full bg-transparent focus:outline-none"
          />
        </label>
        {hidden > 0 && (
          <label className="flex items-center gap-1.5 text-sm" title="The CA bundle in every namespace, Helm release records and service-account tokens">
            <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
            Show {hidden} made by Kubernetes or Helm
          </label>
        )}
      </div>

      <Section
        title="ConfigMaps"
        hint="Settings an app reads as files or environment variables."
        clusterId={clusterId}
        items={configMaps}
      />
      <Section
        title="Secrets"
        hint="Passwords, keys and certificates. Only names and keys are shown here — never their values."
        clusterId={clusterId}
        items={secrets}
      />
    </div>
  );
}
