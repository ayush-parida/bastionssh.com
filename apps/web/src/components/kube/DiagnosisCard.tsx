import { Link } from 'react-router-dom';
import type { KubeDiagnosis, KubeEvidence } from '@smt/shared';
import { kubeObjectUrl } from '@smt/shared';
import { AlertOctagon, AlertTriangle, ArrowRight, FileText, History, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { ago, type KubeObjectLinkState, type KubeTab } from '@/lib/kube.js';

/**
 * One plain-language problem (spec §5.4): the headline in words, the likely
 * cause, the next step, and the evidence it rests on — each object a link to
 * its panel, each event with its count. For a crash loop, operators also see
 * the last lines the container printed.
 */

/** Text with `backticks` shown as code (names, images, selectors). */
export function Ticks({ text }: { text: string }) {
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.85em]">
            {part}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

const EVIDENCE_ICON = { object: Link2, event: History, fact: FileText } as const;

function Evidence({ clusterId, item, fromTab }: { clusterId: string; item: KubeEvidence; fromTab: KubeTab }) {
  const Icon = EVIDENCE_ICON[item.type];
  const body = (
    <>
      <Icon size={12} className="mt-0.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="font-medium">{item.label}</span>
        {item.detail && <span className="text-muted-foreground"> — {item.detail}</span>}
      </span>
    </>
  );
  // Events link to the object they are about; facts stand alone
  if (item.ref && item.type === 'object') {
    return (
      <li>
        <Link to={kubeObjectUrl(clusterId, item.ref)} state={{ tab: fromTab } satisfies KubeObjectLinkState} className="flex gap-1.5 hover:underline">
          {body}
        </Link>
      </li>
    );
  }
  return <li className="flex gap-1.5">{body}</li>;
}

export default function DiagnosisCard({
  clusterId,
  diagnosis: d,
  fromTab,
  showSubject = false,
}: {
  clusterId: string;
  diagnosis: KubeDiagnosis;
  fromTab: KubeTab;
  /** Name the object (the attention list); a panel already shows it. */
  showSubject?: boolean;
}) {
  const critical = d.severity === 'critical';
  const Icon = critical ? AlertOctagon : AlertTriangle;
  const state: KubeObjectLinkState = { tab: fromTab };
  return (
    <div
      data-testid="diagnosis"
      data-diagnosis={d.id}
      data-severity={d.severity}
      className={cn('rounded-lg border p-3 text-sm', critical ? 'border-red-500/40 bg-red-500/5' : 'border-amber-500/40 bg-amber-500/5')}
    >
      <div className="flex gap-2">
        <Icon size={16} className={cn('mt-0.5 shrink-0', critical ? 'text-red-500' : 'text-amber-500')} />
        <div className="min-w-0 flex-1 space-y-1.5">
          {showSubject && (
            <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <Link to={kubeObjectUrl(clusterId, d.subject)} state={state} className="font-medium text-foreground hover:underline">
                {d.subject.kind} {d.subject.namespace ? `${d.subject.namespace}/` : ''}
                {d.subject.name}
              </Link>
              {d.owner && (
                <Link to={kubeObjectUrl(clusterId, d.owner)} state={state} className="hover:underline">
                  of {d.owner.kind} {d.owner.name}
                </Link>
              )}
              {d.affected > 1 && (
                <span className="rounded-full bg-red-500/15 px-1.5 text-red-600" data-testid="diagnosis-affected">
                  {d.affected} pods
                </span>
              )}
              {d.since && <span>{ago(d.since)}</span>}
            </p>
          )}
          <p className="font-medium leading-snug" data-testid="diagnosis-headline">
            <Ticks text={d.headline} />
          </p>
          <p className="text-muted-foreground" data-testid="diagnosis-cause">
            <Ticks text={d.cause} />
          </p>
          <p className="flex gap-1.5" data-testid="diagnosis-next">
            <ArrowRight size={14} className="mt-0.5 shrink-0 text-primary" />
            <span>
              <Ticks text={d.nextStep} />
            </span>
          </p>
          {d.logTail && d.logTail.length > 0 && (
            <pre className="max-h-48 overflow-auto rounded-md bg-zinc-950 p-2 font-mono text-xs leading-relaxed text-zinc-100" data-testid="diagnosis-logs">
              {d.logTail.join('\n')}
            </pre>
          )}
          {d.evidence.length > 0 && (
            <details className="text-xs" open={!showSubject}>
              <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">Evidence</summary>
              <ul className="mt-1.5 space-y-1">
                {d.evidence.map((e, i) => (
                  <Evidence key={i} clusterId={clusterId} item={e} fromTab={fromTab} />
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
