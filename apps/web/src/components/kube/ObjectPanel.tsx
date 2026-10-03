import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { KubeObjectDetail, KubeObjectRef, KubeResource } from '@smt/shared';
import { KUBE_CLUSTER_SCOPE, kubeObjectPath, kubeObjectUrl } from '@smt/shared';
import { Link2, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { HEALTH_DOT, healthLabel, kubeKeys, kubePath, useKubeChanges, useKubeCluster, type KubeObjectLinkState, type KubeTab } from '@/lib/kube.js';
import ObjectInsight from './ObjectInsight.js';
import ObjectActions from './actions/ObjectActions.js';
import PodOverview from './pod/PodOverview.js';
import PodLogs from './pod/PodLogs.js';
import YamlView from './pod/YamlView.js';

type Tab = 'overview' | 'logs' | 'yaml';

const TAB_LABEL: Record<Tab, string> = { overview: 'Overview', logs: 'Logs', yaml: 'YAML' };

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
 * values stripped by the server. Kept live by the change feed. A pod adds
 * its lifecycle, container lanes with usage, logs and "Open shell" (K4,
 * components/kube/pod). Below come what is wrong with it and its events
 * (`ObjectInsight`, K2) and the guided actions it allows (`ObjectActions`, K3).
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
  /** Which container's logs the Logs tab opens on (a lane's "Logs" picks it); `n` reopens the same one. */
  const [logTarget, setLogTarget] = useState<{ container?: string; previous: boolean; n: number }>({ previous: false, n: 0 });
  const permissions = useKubeCluster(clusterId).data?.permissions;
  const isPod = objectRef.resource === 'pods' && !!objectRef.namespace;
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
  useEffect(() => {
    setTab('overview');
    setLogTarget({ previous: false, n: 0 });
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const d = detail.data;
  const state: KubeObjectLinkState = { tab: fromTab };
  const kind = d?.ref.kind ?? objectRef.resource;
  const tabs: Tab[] = [
    'overview',
    ...(isPod && permissions?.logs ? (['logs'] as const) : []),
    ...(permissions?.yaml ? (['yaml'] as const) : []),
  ];
  const showLogs = (container: string, previous: boolean) => {
    setLogTarget((t) => ({ container, previous, n: t.n + 1 }));
    setTab('logs');
  };

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

        {tabs.length > 1 && (
          <div className="flex gap-1 border-b border-border px-5">
            {tabs.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm',
                  tab === t ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
        )}

        <div className={cn('flex-1 px-5 py-4', tab === 'logs' ? 'flex min-h-0 flex-col' : 'overflow-y-auto')}>
          {tab === 'logs' && isPod ? (
            <PodLogs
              key={`${path}:${logTarget.n}`}
              clusterId={clusterId}
              namespace={objectRef.namespace!}
              name={objectRef.name}
              initialContainer={logTarget.container}
              initialPrevious={logTarget.previous}
            />
          ) : tab === 'yaml' && tabs.includes('yaml') ? (
            <YamlView key={path} clusterId={clusterId} objectRef={objectRef} />
          ) : detail.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </p>
          ) : detail.error ? (
            <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(detail.error as Error).message}</p>
          ) : d ? (
            <div className="space-y-6">
              {isPod && (
                <PodOverview
                  clusterId={clusterId}
                  namespace={objectRef.namespace!}
                  name={objectRef.name}
                  permissions={permissions}
                  version={detail.dataUpdatedAt}
                  onLogs={showLogs}
                />
              )}
              <ObjectInsight clusterId={clusterId} objectRef={objectRef} fromTab={fromTab} podOverview={isPod} />
              <ObjectActions clusterId={clusterId} objectRef={objectRef} onGone={onClose} />

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
