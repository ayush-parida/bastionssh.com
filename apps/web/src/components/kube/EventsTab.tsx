import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { KubeEventList } from '@smt/shared';
import { History, Loader2, Search } from 'lucide-react';
import { api } from '@/lib/api.js';
import { kubeKeys, kubePath, useKubeChanges } from '@/lib/kube.js';
import EventsTimeline from './EventsTimeline.js';

const SINCE = [
  { value: '1h', label: 'Last hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last day' },
  { value: '', label: 'Everything kept' },
];

/** Events: a timeline grouped by object, warnings highlighted, repeats collapsed; live. */
export default function EventsTab({ clusterId, namespace }: { clusterId: string; namespace: string }) {
  const [since, setSince] = useState('');
  const [warningsOnly, setWarningsOnly] = useState(false);
  const [filter, setFilter] = useState('');
  const ns = namespace || null;
  const key = kubeKeys.events(clusterId, ns, since);
  const events = useQuery<KubeEventList>({
    queryKey: key,
    queryFn: () => {
      const q = new URLSearchParams();
      if (ns) q.set('namespace', ns);
      if (since) q.set('since', since);
      const qs = q.toString();
      return api.get(kubePath(clusterId, `/events${qs ? `?${qs}` : ''}`));
    },
    retry: false,
  });
  useKubeChanges(clusterId, 'events', { namespace: ns }, key, events.isSuccess);

  const groups = useMemo(() => {
    const words = filter.trim().toLowerCase();
    return (events.data?.groups ?? [])
      .map((g) => (warningsOnly ? { ...g, events: g.events.filter((e) => e.type === 'Warning') } : g))
      .filter((g) => g.events.length)
      .filter(
        (g) =>
          !words ||
          `${g.object.kind} ${g.object.namespace ?? ''}/${g.object.name}`.toLowerCase().includes(words) ||
          g.events.some((e) => `${e.reason} ${e.message}`.toLowerCase().includes(words)),
      );
  }, [events.data, warningsOnly, filter]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-[12rem] flex-1 items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5 text-sm">
          <Search size={14} className="text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by object, reason or message"
            className="w-full bg-transparent focus:outline-none"
          />
        </label>
        <select
          value={since}
          onChange={(e) => setSince(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          title="How far back"
        >
          {SINCE.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={warningsOnly} onChange={(e) => setWarningsOnly(e.target.checked)} />
          Warnings only
        </label>
      </div>
      {events.data?.warnings.map((w) => (
        <p key={w} className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          {w}
        </p>
      ))}
      {events.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" /> Reading events…
        </p>
      ) : events.error ? (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(events.error as Error).message}</p>
      ) : groups.length ? (
        <EventsTimeline clusterId={clusterId} groups={groups} />
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
          <History size={28} className="text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {filter || warningsOnly ? 'No events match.' : 'Nothing reported recently. Kubernetes keeps events for about an hour.'}
          </p>
        </div>
      )}
    </div>
  );
}
