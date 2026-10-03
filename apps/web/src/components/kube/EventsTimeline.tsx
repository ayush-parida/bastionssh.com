import { Link } from 'react-router-dom';
import type { KubeEventEntry, KubeEventGroup } from '@smt/shared';
import { kubeObjectUrl } from '@smt/shared';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { ago, span, type KubeObjectLinkState } from '@/lib/kube.js';

/**
 * What Kubernetes reported (spec §5.3): grouped by object, newest first,
 * warnings highlighted, and repeats collapsed with their count — "Back-off
 * restarting failed container ×37 in 20 min" rather than thirty-seven lines.
 */

/** One collapsed event line. */
export function EventLine({ event: e }: { event: KubeEventEntry }) {
  const warning = e.type === 'Warning';
  const over = e.count > 1 ? span(e.firstSeen, e.lastSeen) : '';
  return (
    <li
      data-testid="event-line"
      data-type={e.type}
      className={cn('flex gap-2 rounded-md px-2 py-1.5 text-sm', warning && 'bg-amber-500/10')}
    >
      {warning ? (
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
      ) : (
        <Info size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn('font-medium', warning && 'text-amber-700 dark:text-amber-400')}>{e.reason}</span>
          {e.count > 1 && (
            <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums" data-testid="event-count">
              ×{e.count}
              {over && ` in ${over}`}
            </span>
          )}
          <span className="text-xs text-muted-foreground" title={e.lastSeen ?? undefined}>
            {ago(e.lastSeen)}
            {e.source && ` · ${e.source}`}
          </span>
        </p>
        {e.message && <p className="break-words text-muted-foreground">{e.message}</p>}
      </div>
    </li>
  );
}

/** An object's own events (the object panel). */
export function EventLines({ events }: { events: KubeEventEntry[] }) {
  if (!events.length) return <p className="text-sm text-muted-foreground">No recent events. Kubernetes keeps them for about an hour.</p>;
  return (
    <ul className="space-y-1" data-testid="object-events">
      {events.map((e, i) => (
        <EventLine key={`${e.reason}|${e.message}|${i}`} event={e} />
      ))}
    </ul>
  );
}

export default function EventsTimeline({ clusterId, groups }: { clusterId: string; groups: KubeEventGroup[] }) {
  return (
    <ol className="space-y-3" data-testid="events-timeline">
      {groups.map((g) => {
        const title = (
          <>
            <span className="text-muted-foreground">{g.object.kind}</span>{' '}
            <span className="font-medium">
              {g.object.namespace ? `${g.object.namespace}/` : ''}
              {g.object.name}
            </span>
          </>
        );
        return (
          <li
            key={`${g.object.kind}/${g.object.namespace}/${g.object.name}`}
            data-testid="event-group"
            className={cn('rounded-lg border bg-card p-3', g.warnings ? 'border-amber-500/50' : 'border-border')}
          >
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-sm">
              {g.object.resource ? (
                <Link
                  to={kubeObjectUrl(clusterId, { resource: g.object.resource, namespace: g.object.namespace, name: g.object.name })}
                  state={{ tab: 'events' } satisfies KubeObjectLinkState}
                  className="hover:underline"
                >
                  {title}
                </Link>
              ) : (
                <span>{title}</span>
              )}
              {g.warnings > 0 && (
                <span className="rounded-full bg-amber-500/15 px-1.5 text-xs text-amber-700 dark:text-amber-400">
                  {g.warnings} warning{g.warnings === 1 ? '' : 's'}
                </span>
              )}
              <span className="ml-auto text-xs text-muted-foreground">{ago(g.lastSeen)}</span>
            </div>
            <ul className="space-y-1">
              {g.events.map((e, i) => (
                <EventLine key={`${e.reason}|${e.message}|${i}`} event={e} />
              ))}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}
