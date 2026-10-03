import type { KubeEventEntry, KubeEventGroup } from '@smt/shared';
import { KUBE_RESOURCES, kubeResourceOfKind } from '@smt/shared';
import type { KubeObject } from './client.js';

/**
 * Kubernetes events (core `v1` Event objects, from the watch cache) as the
 * events timeline and the diagnoses read them (spec §5.3, §5.4). Only the
 * plain fields leave the server — type, reason, message, when, how often and
 * who reported it — never the raw object.
 *
 * Kubernetes already folds repeats into one Event with a `count` (or a
 * `series`); we fold further, so the same reason and message on the same
 * object show as one line: "Back-off restarting failed container ×37 in 20 min".
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** Longest message kept per event line (a FailedScheduling message on a big cluster can run long). */
const MAX_MESSAGE = 2_000;

/** One event, read. */
export interface KubeEventView {
  kind: string;
  namespace: string | null;
  name: string;
  type: 'Normal' | 'Warning';
  reason: string;
  message: string;
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  source: string | null;
}

/** Plain fields of an Event; null for something that is not one (no involved object). */
export function readEvent(e: KubeObject): KubeEventView | null {
  const involved = obj(e.involvedObject);
  const kind = str(involved.kind);
  const name = str(involved.name);
  if (!kind || !name) return null;
  const series = obj(e.series);
  const created = e.metadata.creationTimestamp ?? null;
  const eventTime = str(e.eventTime);
  const lastSeen = str(e.lastTimestamp) ?? str(series.lastObservedTime) ?? eventTime ?? created;
  const firstSeen = str(e.firstTimestamp) ?? eventTime ?? created ?? lastSeen;
  const message = (str(e.message) ?? '').trim();
  return {
    kind,
    namespace: str(involved.namespace) ?? null,
    name,
    type: e.type === 'Warning' ? 'Warning' : 'Normal',
    reason: str(e.reason) ?? 'Unknown',
    message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message,
    count: Math.max(1, num(series.count, num(e.count, 1))),
    firstSeen,
    lastSeen,
    source: str(obj(e.source).component) ?? str(e.reportingComponent),
  };
}

const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);

/** Newest first. */
export const byLastSeen = (a: { lastSeen: string | null }, b: { lastSeen: string | null }) => time(b.lastSeen) - time(a.lastSeen);

/** `Kind/namespace/name` of the object an event is about. */
export const eventKey = (kind: string, namespace: string | null, name: string) => `${kind}/${namespace ?? ''}/${name}`;

/** Events by the object they are about, each list newest first. */
export class EventIndex {
  private readonly byObject = new Map<string, KubeEventView[]>();

  constructor(events: KubeObject[]) {
    for (const raw of events) {
      const e = readEvent(raw);
      if (!e) continue;
      const key = eventKey(e.kind, e.namespace, e.name);
      const list = this.byObject.get(key);
      if (list) list.push(e);
      else this.byObject.set(key, [e]);
    }
    for (const list of this.byObject.values()) list.sort(byLastSeen);
  }

  /** Events about one object, newest first. */
  for(kind: string, namespace: string | null, name: string): KubeEventView[] {
    return this.byObject.get(eventKey(kind, namespace, name)) ?? [];
  }

  /** The newest event about the object with `reason` (and, when given, a message matching `message`). */
  latest(kind: string, namespace: string | null, name: string, reason: string | RegExp, message?: RegExp): KubeEventView | null {
    return (
      this.for(kind, namespace, name).find(
        (e) => (typeof reason === 'string' ? e.reason === reason : reason.test(e.reason)) && (!message || message.test(e.message)),
      ) ?? null
    );
  }

  all(): KubeEventView[][] {
    return [...this.byObject.values()];
  }
}

/** Fold repeats (same type, reason and message) into one line with their total count; newest first. */
export function collapseEvents(events: KubeEventView[]): KubeEventEntry[] {
  const lines = new Map<string, KubeEventEntry>();
  for (const e of events) {
    const key = `${e.type}|${e.reason}|${e.message}`;
    const line = lines.get(key);
    if (!line) {
      lines.set(key, {
        type: e.type,
        reason: e.reason,
        message: e.message,
        count: e.count,
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
        source: e.source,
      });
      continue;
    }
    line.count += e.count;
    if (e.firstSeen && (!line.firstSeen || time(e.firstSeen) < time(line.firstSeen))) line.firstSeen = e.firstSeen;
    if (e.lastSeen && (!line.lastSeen || time(e.lastSeen) > time(line.lastSeen))) {
      line.lastSeen = e.lastSeen;
      line.source = e.source ?? line.source;
    }
  }
  return [...lines.values()].sort(byLastSeen);
}

/**
 * The events timeline: events grouped by the object they are about, groups
 * with the newest event first, repeats collapsed. `since` drops events last
 * seen before it; `maxGroups` keeps the newest groups.
 */
export function groupEvents(events: KubeObject[], opts: { since?: number | null; maxGroups?: number } = {}): KubeEventGroup[] {
  const index = new EventIndex(events);
  const groups: KubeEventGroup[] = [];
  for (const list of index.all()) {
    const recent = opts.since ? list.filter((e) => time(e.lastSeen) >= opts.since!) : list;
    if (!recent.length) continue;
    const first = recent[0]!;
    const resource = kubeResourceOfKind(first.kind);
    const entries = collapseEvents(recent);
    groups.push({
      object: {
        resource,
        kind: first.kind,
        // A cluster-scoped object's events are filed in a namespace (usually default); its link has none
        namespace: resource && !KUBE_RESOURCES[resource].namespaced ? null : first.namespace,
        name: first.name,
      },
      warnings: entries.filter((e) => e.type === 'Warning').reduce((n, e) => n + e.count, 0),
      lastSeen: entries[0]?.lastSeen ?? null,
      events: entries,
    });
  }
  groups.sort(byLastSeen);
  return opts.maxGroups ? groups.slice(0, opts.maxGroups) : groups;
}
