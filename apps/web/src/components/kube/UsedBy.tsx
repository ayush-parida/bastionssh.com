import { Link } from 'react-router-dom';
import type { KubeConsumer, KubeObjectRef } from '@smt/shared';
import { kubeObjectUrl } from '@smt/shared';
import { cn } from '@/lib/utils.js';
import type { KubeObjectLinkState, KubeTab } from '@/lib/kube.js';

/** A link to an object's panel, as a small chip: `Deployment web`. */
export function ObjectChip({ clusterId, objectRef, fromTab, className }: { clusterId: string; objectRef: KubeObjectRef; fromTab: KubeTab; className?: string }) {
  return (
    <Link
      to={kubeObjectUrl(clusterId, objectRef)}
      state={{ tab: fromTab } satisfies KubeObjectLinkState}
      className={cn('inline-flex max-w-full items-center gap-1 truncate rounded bg-muted px-1.5 py-0.5 text-xs hover:bg-muted/70 hover:underline', className)}
      title={`${objectRef.kind} ${objectRef.namespace ? `${objectRef.namespace}/` : ''}${objectRef.name}`}
    >
      <span className="text-muted-foreground">{objectRef.kind}</span>
      <span className="truncate font-medium">{objectRef.name}</span>
    </Link>
  );
}

const HOW: Record<KubeConsumer['how'][number], string> = { mounts: 'as files', env: 'as environment variables' };

/**
 * What reads a ConfigMap, Secret or storage claim — each a link, with how
 * (files or environment variables) — or, when nothing does, `none` in words.
 */
export default function UsedBy({ clusterId, consumers, fromTab, none }: { clusterId: string; consumers: KubeConsumer[]; fromTab: KubeTab; none: string }) {
  if (!consumers.length) return <p className="text-xs text-muted-foreground">{none}</p>;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">Used by</span>
      {consumers.map((c) => (
        <span key={`${c.ref.kind}/${c.ref.name}`} className="inline-flex items-center gap-1" title={`Read ${c.how.map((h) => HOW[h]).join(' and ')}`}>
          <ObjectChip clusterId={clusterId} objectRef={c.ref} fromTab={fromTab} />
          <span className="text-muted-foreground">{c.how.map((h) => HOW[h]).join(' + ')}</span>
        </span>
      ))}
    </div>
  );
}
