import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { KubeObjectDetail, KubeObjectRef, KubeResource } from '@smt/shared';
import { KUBE_CLUSTER_SCOPE, kubeObjectPath, kubeObjectUrl } from '@smt/shared';
import { Copy, Link2, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { HEALTH_DOT, healthLabel, kubeKeys, kubePath, useKubeChanges, type KubeObjectLinkState, type KubeTab } from '@/lib/kube.js';

type Tab = 'overview' | 'yaml';

/** Related objects in reading order: what it belongs to, then what it runs or reaches. */
const RELATION_ORDER = ['owned by', 'runs on', 'routes to', 'scales', 'bound to', 'mounts', 'reads env from', 'sends traffic to', 'owns', 'runs'];

function groupRelated(related: KubeObjectDetail['related']) {
  const groups = new Map<string, KubeObjectDetail['related']>();
  for (const r of related) groups.set(r.relation, [...(groups.get(r.relation) ?? []), r]);
  return [...groups.entries()].sort(
    ([a], [b]) => (RELATION_ORDER.indexOf(a) + 1 || 99) - (RELATION_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b),
  );
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.message('Select the text to copy it');
  }
}

/**
 * One object's panel, opened over the cluster page at the object's stable
 * URL (`/kubernetes/<cluster>/objects/<resource>/<namespace>/<name>`): its
 * health in a word, key facts, labels, what it is related to (each a link to
 * that object's panel) and, for operators and up, read-only YAML with secret
 * values stripped by the server. Kept live by the change feed. Later phases
 * add the pod lifecycle, logs, shell and guided actions here.
 */
export default function ObjectPanel({
  clusterId,
  objectRef,
  fromTab,
  onClose,
}: {
  clusterId: string;
  objectRef: Pick<KubeObjectRef, 'resource' | 'namespace' | 'name'>;
  fromTab: KubeTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('overview');
  const path = kubeObjectPath(objectRef);
  const detail = useQuery<KubeObjectDetail>({
    queryKey: kubeKeys.object(clusterId, path),
    queryFn: () => api.get(kubePath(clusterId, `/${path}`)),
    retry: false,
  });
  useKubeChanges(
    clusterId,
    'object',
    { resource: objectRef.resource, namespace: objectRef.namespace, name: objectRef.name },
    kubeKeys.object(clusterId, path),
    detail.isSuccess,
  );

  // Another object opened in the same panel starts on its overview
  useEffect(() => setTab('overview'), [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const d = detail.data;
  const state: KubeObjectLinkState = { tab: fromTab };
  const kind = d?.ref.kind ?? objectRef.resource;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${kind} ${objectRef.name}`}
        data-testid="kube-object-panel"
        className="flex h-full w-full max-w-2xl flex-col border-l border-border bg-card shadow-xl"
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{kind}</p>
            <p className="truncate text-lg font-semibold" title={objectRef.name}>
              {objectRef.name}
            </p>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {objectRef.namespace && <span>namespace {objectRef.namespace}</span>}
              {d?.health && (
                <span className="flex items-center gap-1.5 text-foreground" data-testid="object-health">
                  <span className={cn('size-2.5 rounded-full', HEALTH_DOT[d.health])} />
                  {healthLabel(d.health)}
                </span>
              )}
            </p>
          </div>
          <button
            onClick={() => copy(window.location.origin + kubeObjectUrl(clusterId, objectRef), 'Link')}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Copy a link to this object"
          >
            <Link2 size={15} />
          </button>
          <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Close">
            <X size={15} />
          </button>
        </div>

        {d?.yaml !== undefined && (
          <div className="flex gap-1 border-b border-border px-5">
            {(['overview', 'yaml'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm',
                  tab === t ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t === 'overview' ? 'Overview' : 'YAML'}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {detail.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </p>
          ) : detail.error ? (
            <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(detail.error as Error).message}</p>
          ) : d && tab === 'yaml' && d.yaml !== undefined ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>Read-only. Secret values and environment values taken from Secrets are removed.</span>
                <button onClick={() => copy(d.yaml!, 'YAML')} className="flex items-center gap-1 hover:text-foreground">
                  <Copy size={12} /> Copy
                </button>
              </div>
              <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">{d.yaml}</pre>
            </div>
          ) : d ? (
            <div className="space-y-6">
              {d.facts.length > 0 && (
                <dl className="divide-y divide-border rounded-md border border-border" data-testid="object-facts">
                  {d.facts.map((f) => (
                    <div key={f.label} className="grid grid-cols-[9rem_1fr] gap-2 px-3 py-2 text-sm">
                      <dt className="text-muted-foreground">{f.label}</dt>
                      <dd className="min-w-0 break-words">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {Object.keys(d.labels).length > 0 && (
                <div>
                  <p className="mb-2 text-sm font-medium">Labels</p>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(d.labels).map(([k, v]) => (
                      <span key={k} className="max-w-full truncate rounded bg-muted px-2 py-0.5 font-mono text-xs" title={`${k}=${v}`}>
                        {k}={v}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {d.related.length > 0 && (
                <div className="space-y-3">
                  <p className="text-sm font-medium">Related</p>
                  {groupRelated(d.related).map(([relation, items]) => (
                    <div key={relation}>
                      <p className="mb-1 text-xs text-muted-foreground">
                        {kind} {relation}
                      </p>
                      <ul className="flex flex-wrap gap-1.5">
                        {items.map((r) => (
                          <li key={`${r.resource}/${r.namespace}/${r.name}`}>
                            <Link
                              to={kubeObjectUrl(clusterId, r)}
                              state={state}
                              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                            >
                              <span className="text-muted-foreground">{r.kind}</span>
                              <span className="truncate font-medium">{r.name}</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

/** The resource and namespace of an object URL's segments (`_` = cluster-scoped). */
export function refFromParams(resource: string, ns: string, name: string): Pick<KubeObjectRef, 'resource' | 'namespace' | 'name'> {
  return { resource: resource as KubeResource, namespace: ns === KUBE_CLUSTER_SCOPE ? null : ns, name };
}
