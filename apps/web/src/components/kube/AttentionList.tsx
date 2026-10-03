import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { KubeAttentionList } from '@smt/shared';
import { CheckCircle2, ChevronDown, ChevronRight, Siren } from 'lucide-react';
import { api } from '@/lib/api.js';
import { kubeKeys, kubePath, useKubeChanges, type KubeTab } from '@/lib/kube.js';
import DiagnosisCard from './DiagnosisCard.js';

/** Problems shown before "Show all". */
const FIRST = 5;

/**
 * "Needs attention" (spec §5.4): the cluster's problems in plain words,
 * ranked — critical first, then the ones hitting most pods, then the newest —
 * across namespaces (or the picked one). A workload's failing replicas are
 * one line. Live.
 */
export default function AttentionList({ clusterId, namespace, fromTab }: { clusterId: string; namespace: string; fromTab: KubeTab }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(true);
  const ns = namespace || null;
  const key = kubeKeys.attention(clusterId, ns);
  const attention = useQuery<KubeAttentionList>({
    queryKey: key,
    queryFn: () => api.get(kubePath(clusterId, `/attention${ns ? `?namespace=${encodeURIComponent(ns)}` : ''}`)),
    retry: false,
  });
  useKubeChanges(clusterId, 'attention', { namespace: ns }, key, attention.isSuccess);

  const items = attention.data?.items;
  if (!items) return null;
  if (!items.length) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-muted-foreground" data-testid="attention-list">
        <CheckCircle2 size={15} className="text-emerald-500" /> Nothing needs attention{ns ? ` in ${ns}` : ''}.
      </p>
    );
  }
  const critical = items.filter((d) => d.severity === 'critical').length;
  const shown = all ? items : items.slice(0, FIRST);
  return (
    <section className="rounded-lg border border-red-500/40 bg-card" data-testid="attention-list">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Siren size={15} className="text-red-500" />
        <span className="font-medium">Needs attention</span>
        <span className="text-muted-foreground">
          {items.length} problem{items.length === 1 ? '' : 's'}
          {critical ? `, ${critical} critical` : ''}
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-4 pb-4">
          {shown.map((d, i) => (
            <DiagnosisCard key={`${d.id}/${d.subject.kind}/${d.subject.namespace}/${d.subject.name}/${i}`} clusterId={clusterId} diagnosis={d} fromTab={fromTab} showSubject />
          ))}
          {items.length > FIRST && (
            <button onClick={() => setAll(!all)} className="text-sm text-primary hover:underline">
              {all ? 'Show fewer' : `Show all ${items.length}`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
