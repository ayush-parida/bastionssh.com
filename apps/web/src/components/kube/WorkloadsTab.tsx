import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { KubeWorkload, KubeWorkloadKind, KubeWorkloadList } from '@smt/shared';
import { KUBE_WORKLOAD_KINDS, kubeObjectUrl, kubeResourceOfKind } from '@smt/shared';
import { AlertTriangle, Search } from 'lucide-react';
import { api } from '@/lib/api.js';
import { cn, relativeTime } from '@/lib/utils.js';
import { HEALTH_DOT, HEALTH_LABEL, kubeKeys, kubePath, useKubeChanges, type KubeObjectLinkState } from '@/lib/kube.js';

const KIND_LABEL: Record<KubeWorkloadKind, string> = {
  Deployment: 'Deployments',
  StatefulSet: 'StatefulSets',
  DaemonSet: 'DaemonSets',
  Job: 'Jobs',
  CronJob: 'CronJobs',
};

/** How bad, for sorting: problems first. */
const SEVERITY: Record<KubeWorkload['health'], number> = {
  failed: 0,
  degraded: 1,
  progressing: 2,
  healthy: 3,
  suspended: 4,
  idle: 5,
  completed: 6,
};

/** A ready / desired ring: how full the workload is, at a glance. */
export function ReplicaRing({ ready, desired, size = 22 }: { ready: number; desired: number; size?: number }) {
  const r = size / 2 - 2.5;
  const circumference = 2 * Math.PI * r;
  const share = desired ? Math.min(1, ready / desired) : 0;
  const color = !desired ? 'stroke-zinc-400' : share >= 1 ? 'stroke-emerald-500' : share > 0 ? 'stroke-amber-500' : 'stroke-red-500';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} className="fill-none stroke-muted" strokeWidth={3} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className={cn('fill-none transition-[stroke-dashoffset]', color)}
        strokeWidth={3}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - share)}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Workloads with their health, problems first; a row opens the workload. */
export default function WorkloadsTab({ clusterId, namespace }: { clusterId: string; namespace: string }) {
  const navigate = useNavigate();
  const [kind, setKind] = useState<KubeWorkloadKind | null>(null);
  const [search, setSearch] = useState('');
  const ns = namespace || null;
  const list = useQuery<KubeWorkloadList>({
    queryKey: kubeKeys.workloads(clusterId, ns),
    queryFn: () => api.get(kubePath(clusterId, `/workloads${ns ? `?namespace=${encodeURIComponent(ns)}` : ''}`)),
    retry: false,
  });
  useKubeChanges(clusterId, 'workloads', { namespace: ns }, kubeKeys.workloads(clusterId, ns), list.isSuccess);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (list.data?.workloads ?? [])
      .filter((w) => !kind || w.kind === kind)
      .filter((w) => !q || w.name.includes(q) || w.namespace.includes(q) || w.images.some((i) => i.toLowerCase().includes(q)))
      .sort((a, b) => SEVERITY[a.health] - SEVERITY[b.health] || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
  }, [list.data, kind, search]);

  const counts = useMemo(() => {
    const c = new Map<KubeWorkloadKind, number>();
    for (const w of list.data?.workloads ?? []) c.set(w.kind, (c.get(w.kind) ?? 0) + 1);
    return c;
  }, [list.data]);

  if (list.error) return <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(list.error as Error).message}</p>;
  if (!list.data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-3">
      {list.data.warnings.map((w) => (
        <p key={w} className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {w}
        </p>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setKind(null)}
          className={cn('rounded-full border px-3 py-1 text-xs', !kind ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted')}
        >
          All <span className="text-muted-foreground">{list.data.workloads.length}</span>
        </button>
        {KUBE_WORKLOAD_KINDS.map((k) => (
          <button
            key={k}
            onClick={() => setKind(kind === k ? null : k)}
            disabled={!counts.get(k)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs disabled:opacity-40',
              kind === k ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted',
            )}
          >
            {KIND_LABEL[k]} <span className="text-muted-foreground">{counts.get(k) ?? 0}</span>
          </button>
        ))}
        <div className="relative ml-auto">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name or image"
            className="w-56 rounded-md border border-input bg-background py-1.5 pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">No workloads here.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Health</th>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Kind</th>
                <th className="px-4 py-2 font-medium">State</th>
                <th className="px-4 py-2 font-medium">Image</th>
                <th className="px-4 py-2 font-medium">Age</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((w) => {
                const resource = kubeResourceOfKind(w.kind)!;
                return (
                  <tr
                    key={`${w.kind}/${w.namespace}/${w.name}`}
                    data-testid="workload-row"
                    data-health={w.health}
                    onClick={() =>
                      navigate(kubeObjectUrl(clusterId, { resource, namespace: w.namespace, name: w.name }), {
                        state: { tab: 'workloads' } satisfies KubeObjectLinkState,
                      })
                    }
                    className="cursor-pointer hover:bg-muted/40"
                  >
                    <td className="px-4 py-2">
                      <span className="flex items-center gap-2 whitespace-nowrap">
                        {w.desired !== null && w.ready !== null && w.kind !== 'Job' ? (
                          <ReplicaRing ready={w.ready} desired={w.desired} />
                        ) : (
                          <span className={cn('size-2.5 rounded-full', HEALTH_DOT[w.health])} />
                        )}
                        <span className="text-xs">{HEALTH_LABEL[w.health]}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <span className="font-medium">{w.name}</span>
                      <span className="block text-xs text-muted-foreground">{w.namespace}</span>
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{w.kind}</td>
                    <td className="px-4 py-2 text-xs">
                      {w.summary}
                      {w.lastRunAt && <span className="block text-muted-foreground">last run {relativeTime(w.lastRunAt)}</span>}
                    </td>
                    <td className="max-w-[16rem] truncate px-4 py-2 font-mono text-xs text-muted-foreground" title={w.images.join('\n')}>
                      {w.images.join(', ')}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground">{w.createdAt ? relativeTime(w.createdAt) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
