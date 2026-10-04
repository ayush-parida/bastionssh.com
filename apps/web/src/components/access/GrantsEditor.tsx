import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  AccessLevel,
  AccessResources,
  GrantInput,
  GrantSelector,
  ResourceSummary,
  ResourceType,
  RoleGrant,
} from '@smt/shared';
import { Plus, Search, Tag, X } from 'lucide-react';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import {
  DURATION_OPTIONS,
  LEVEL_LABELS,
  LEVEL_VERBS,
  LEVELS,
  RESOURCE_SECTIONS,
  RESOURCE_TYPE_LABELS,
} from '@/lib/access.js';
import { ExpiryBadge } from './ExpiryBadge.js';

/**
 * The resource list of a custom role or of a member's personal grants
 * (custom roles spec §7): per type, specific items, "All …", or (servers)
 * "Servers tagged …" with a live count; clusters may be narrowed to
 * namespaces; each entry has its level and, optionally, an expiry.
 */

/** Every resource of every type, for the pickers. Admins only. */
export function useAccessResources() {
  return useQuery<AccessResources>({
    queryKey: ['access-resources'],
    queryFn: () => api.get('/team/access/resources'),
    staleTime: 30_000,
  });
}

/** How long an entry lasts, as picked: as it is now, forever, or minutes from now. */
export type ExpiryChoice = 'keep' | 'permanent' | number;

export interface EditableGrant {
  key: string;
  resourceType: ResourceType;
  selector: GrantSelector;
  resourceId: string | null;
  tag: string | null;
  namespaces: string[] | null;
  level: AccessLevel;
  /** The expiry it has now (existing entries). */
  expiresAt: string | null;
  expiry: ExpiryChoice;
}

let keySeq = 0;
const nextKey = () => `g${++keySeq}`;

export function toEditable(grants: RoleGrant[]): EditableGrant[] {
  return grants.map((g) => ({
    key: nextKey(),
    resourceType: g.resourceType,
    selector: g.selector,
    resourceId: g.resourceId,
    tag: g.tag,
    namespaces: g.namespaces,
    level: g.level,
    expiresAt: g.expiresAt,
    expiry: g.expiresAt ? 'keep' : 'permanent',
  }));
}

export function toGrantInputs(grants: EditableGrant[]): GrantInput[] {
  return grants.map((g) => ({
    resourceType: g.resourceType,
    selector: g.selector,
    resourceId: g.resourceId,
    tag: g.tag,
    namespaces: g.namespaces?.length ? g.namespaces : null,
    level: g.level,
    ...(g.expiry === 'keep'
      ? { expiresAt: g.expiresAt }
      : g.expiry === 'permanent'
        ? { expiresAt: null }
        : { expiresInMinutes: g.expiry }),
  }));
}

/** The resources an entry covers right now (tags are matched live, like the server does). */
export function matches(grant: Pick<EditableGrant, 'resourceType' | 'selector' | 'resourceId' | 'tag'>, resources: AccessResources | undefined): ResourceSummary[] {
  const all = resources?.[grant.resourceType] ?? [];
  if (grant.selector === 'all') return all;
  if (grant.selector === 'tag') return all.filter((r) => grant.tag && r.tags?.includes(grant.tag));
  return all.filter((r) => r.id === grant.resourceId);
}

function entryLabel(g: EditableGrant, resources: AccessResources | undefined): string {
  const labels = RESOURCE_TYPE_LABELS[g.resourceType];
  if (g.selector === 'all') return `All ${labels.many}`;
  if (g.selector === 'tag') return `Servers tagged ${g.tag}`;
  return resources?.[g.resourceType].find((r) => r.id === g.resourceId)?.name ?? 'Deleted resource';
}

const selectClass =
  'rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary';

/** "Add servers…": search specific items, "All …", and (servers) tags with how many servers carry them. */
function Picker({
  type,
  title,
  resources,
  onPick,
}: {
  type: ResourceType;
  title: string;
  resources: AccessResources | undefined;
  onPick: (pick: { selector: GrantSelector; resourceId?: string; tag?: string }) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const items = useMemo(() => resources?.[type] ?? [], [resources, type]);
  const q = query.trim().toLowerCase();
  const labels = RESOURCE_TYPE_LABELS[type];

  const tags = useMemo(() => {
    if (type !== 'server') return [];
    const counts = new Map<string, number>();
    for (const s of items) for (const t of s.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  }, [items, type]);

  const matchingItems = items.filter((r) => !q || r.name.toLowerCase().includes(q) || r.detail?.toLowerCase().includes(q));
  const matchingTags = tags.filter(([t]) => !q || t.toLowerCase().includes(q));
  // A tag nobody carries yet still works: servers tagged later are covered at once
  const typedTag = type === 'server' && q && !tags.some(([t]) => t.toLowerCase() === q) ? query.trim() : null;

  const pick = (p: { selector: GrantSelector; resourceId?: string; tag?: string }) => {
    onPick(p);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2">
        <Search size={13} className="shrink-0 text-muted-foreground" />
        <input
          aria-label={`Add ${title}`}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={`Add ${labels.many}${type === 'server' ? ', “All servers” or a tag' : ''}…`}
          className="w-full bg-transparent py-1.5 text-sm focus:outline-none"
        />
      </div>
      {open && (
        <div
          role="listbox"
          aria-label={`${title} to add`}
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-card shadow-lg"
        >
          {(!q || `all ${labels.many}`.includes(q)) && (
            <button type="button" role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => pick({ selector: 'all' })} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted">
              <Plus size={12} /> All {labels.many} <span className="ml-auto text-xs text-muted-foreground">{items.length} now, and any added later</span>
            </button>
          )}
          {matchingTags.map(([t, n]) => (
            <button key={`tag:${t}`} type="button" role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => pick({ selector: 'tag', tag: t })} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted">
              <Tag size={12} /> Servers tagged {t} <span className="ml-auto text-xs text-muted-foreground">{n} server{n === 1 ? '' : 's'}</span>
            </button>
          ))}
          {typedTag && (
            <button type="button" role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => pick({ selector: 'tag', tag: typedTag })} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted">
              <Tag size={12} /> Servers tagged {typedTag} <span className="ml-auto text-xs text-muted-foreground">0 servers yet</span>
            </button>
          )}
          {matchingItems.map((r) => (
            <button key={r.id} type="button" role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => pick({ selector: 'id', resourceId: r.id })} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted">
              <span className="truncate">{r.name}</span>
              {r.detail && <span className="ml-auto truncate font-mono text-xs text-muted-foreground">{r.detail}</span>}
            </button>
          ))}
          {!matchingItems.length && !matchingTags.length && !typedTag && q && (
            <p className="px-3 py-2 text-sm text-muted-foreground">No {labels.many} match.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Namespace chips for a cluster entry; none = every namespace. */
function NamespaceChips({ namespaces, onChange }: { namespaces: string[] | null; onChange: (ns: string[] | null) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const ns = draft.trim().toLowerCase();
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(ns)) return;
    onChange([...new Set([...(namespaces ?? []), ns])]);
    setDraft('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1 pl-1">
      <span className="text-xs text-muted-foreground">Namespaces:</span>
      {!namespaces?.length && <span className="text-xs text-muted-foreground italic">all</span>}
      {namespaces?.map((ns) => (
        <span key={ns} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          {ns}
          <button type="button" aria-label={`Remove namespace ${ns}`} onClick={() => onChange(namespaces.filter((n) => n !== ns).length ? namespaces.filter((n) => n !== ns) : null)}>
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        aria-label="Add namespace"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        onBlur={add}
        placeholder="add namespace"
        className="w-28 rounded border border-input bg-background px-1.5 py-0.5 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </div>
  );
}

export function GrantsEditor({
  grants,
  onChange,
  resources,
}: {
  grants: EditableGrant[];
  onChange: (grants: EditableGrant[]) => void;
  resources: AccessResources | undefined;
}) {
  const update = (key: string, patch: Partial<EditableGrant>) =>
    onChange(grants.map((g) => (g.key === key ? { ...g, ...patch } : g)));

  return (
    <div className="space-y-4">
      {RESOURCE_SECTIONS.map(({ type, title }) => {
        const entries = grants.filter((g) => g.resourceType === type);
        return (
          <div key={type} className="space-y-2" data-testid={`grants-${type}`}>
            <p className="text-sm font-medium">{title}</p>
            {entries.map((g) => {
              const covered = matches(g, resources);
              return (
                <div key={g.key} className="rounded-md border border-border px-3 py-2 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="flex-1 min-w-0 truncate font-medium">{entryLabel(g, resources)}</span>
                    {g.selector !== 'id' && (
                      <span className="text-xs text-muted-foreground" title={covered.map((r) => r.name).join(', ')}>
                        {covered.length} {covered.length === 1 ? RESOURCE_TYPE_LABELS[type].one : RESOURCE_TYPE_LABELS[type].many} now
                      </span>
                    )}
                    {g.expiry === 'keep' && g.expiresAt && <ExpiryBadge expiresAt={g.expiresAt} />}
                    <select
                      aria-label={`Level for ${entryLabel(g, resources)}`}
                      value={g.level}
                      onChange={(e) => update(g.key, { level: e.target.value as AccessLevel })}
                      className={selectClass}
                    >
                      {LEVELS.map((l) => (
                        <option key={l} value={l}>{LEVEL_LABELS[l]} — {LEVEL_VERBS[type][l]}</option>
                      ))}
                    </select>
                    <select
                      aria-label={`Expiry for ${entryLabel(g, resources)}`}
                      value={String(g.expiry)}
                      onChange={(e) => {
                        const v = e.target.value;
                        update(g.key, { expiry: v === 'keep' || v === 'permanent' ? v : Number(v) });
                      }}
                      className={selectClass}
                    >
                      {g.expiresAt && <option value="keep">Keep expiry</option>}
                      <option value="permanent">Permanent</option>
                      {DURATION_OPTIONS.map((o) => (
                        <option key={o.minutes} value={o.minutes}>For {o.label}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label={`Remove ${entryLabel(g, resources)}`}
                      onClick={() => onChange(grants.filter((x) => x.key !== g.key))}
                      className="text-muted-foreground hover:text-red-500"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {type === 'cluster' && (
                    <NamespaceChips namespaces={g.namespaces} onChange={(namespaces) => update(g.key, { namespaces })} />
                  )}
                </div>
              );
            })}
            <Picker
              type={type}
              title={title}
              resources={resources}
              onPick={(p) =>
                onChange([
                  ...grants,
                  {
                    key: nextKey(),
                    resourceType: type,
                    selector: p.selector,
                    resourceId: p.resourceId ?? null,
                    tag: p.tag ?? null,
                    namespaces: null,
                    level: 'view',
                    expiresAt: null,
                    expiry: 'permanent',
                  },
                ])
              }
            />
          </div>
        );
      })}
    </div>
  );
}

/** "web-1, web-2 and 3 more" */
function nameList(names: string[], max = 4): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/**
 * The plain-language preview: "Members of this role will be able to open
 * terminals and files on 3 servers (web-1, web-2, edge-1 via tag frontend), view
 * namespace shop on shop-prod, …". Each resource counts once, at its highest level.
 */
export function GrantPreview({
  grants,
  resources,
  subject = 'Members of this role',
}: {
  grants: EditableGrant[];
  resources: AccessResources | undefined;
  subject?: string;
}) {
  const lines: string[] = [];
  for (const { type } of RESOURCE_SECTIONS) {
    const labels = RESOURCE_TYPE_LABELS[type];
    const best = new Map<string, { level: AccessLevel; name: string; how: string | null }>();
    const narrowed: string[] = [];
    for (const g of grants.filter((x) => x.resourceType === type)) {
      if (type === 'cluster' && g.namespaces?.length) {
        for (const r of matches(g, resources)) {
          narrowed.push(`${LEVEL_LABELS[g.level].toLowerCase()} namespace${g.namespaces.length === 1 ? '' : 's'} ${g.namespaces.join(', ')} on ${r.name}`);
        }
        continue;
      }
      for (const r of matches(g, resources)) {
        const prior = best.get(r.id);
        if (!prior || LEVELS.indexOf(g.level) > LEVELS.indexOf(prior.level)) {
          best.set(r.id, { level: g.level, name: r.name, how: g.selector === 'tag' ? `via tag ${g.tag}` : null });
        }
      }
    }
    for (const level of [...LEVELS].reverse()) {
      const at = [...best.values()].filter((b) => b.level === level);
      if (!at.length) continue;
      const names = at.map((b) => (b.how ? `${b.name} ${b.how}` : b.name));
      lines.push(`${LEVEL_VERBS[type][level]} ${at.length} ${at.length === 1 ? labels.one : labels.many} (${nameList(names)})`);
    }
    lines.push(...narrowed);
    if (grants.some((g) => g.resourceType === type && g.selector === 'all')) {
      lines.push(`and any ${labels.one} added later`);
    }
  }
  return (
    <div className={cn('rounded-md border border-border bg-muted/30 p-3 text-sm')} data-testid="grant-preview">
      {lines.length === 0 ? (
        <p className="text-muted-foreground">{subject} get nothing from this list yet.</p>
      ) : (
        <>
          <p className="mb-1 font-medium">{subject} will be able to:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {lines.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}
