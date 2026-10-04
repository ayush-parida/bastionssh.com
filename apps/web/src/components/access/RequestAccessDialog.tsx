import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccessLevel,
  AccessRequest,
  CreateAccessRequest,
  RequestableAccess,
  RequestableServers,
  ResourceType,
} from '@smt/shared';
import { MODULES } from '@smt/shared';
import { KeyRound, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import {
  DURATION_OPTIONS,
  formatMinutes,
  LEVEL_LABELS,
  LEVEL_HINTS,
  LEVELS,
  RESOURCE_SECTIONS,
  RESOURCE_TYPE_LABELS,
  levelAtLeast,
} from '@/lib/access.js';
import { moduleAtLeast, useMeAccess } from '@/hooks/useModules.js';
import { ExpiryBadge } from './ExpiryBadge.js';
import { RoleDot } from './AccessBadges.js';
import { NamespaceChips } from './GrantsEditor.js';

/** What a restricted member may ask for. Shared by the Servers and Team pages. */
export function useRequestableServers() {
  return useQuery<RequestableServers>({
    queryKey: ['requestable-servers'],
    queryFn: () => api.get('/access-requests/servers'),
  });
}

/** Roles and resources the member may ask for (custom roles spec §6). */
export function useRequestableAccess() {
  return useQuery<RequestableAccess>({
    queryKey: ['requestable-access'],
    queryFn: () => api.get('/access-requests/requestable'),
  });
}

/** Durations up to the org's maximum, with the maximum itself always offered. */
export function durationChoices(max: number) {
  const choices = DURATION_OPTIONS.filter((o) => o.minutes <= max);
  if (!choices.some((o) => o.minutes === max)) choices.push({ minutes: max, label: formatMinutes(max) });
  return choices;
}

/**
 * Ask admins for time-bound access, with a reason: a custom role, or a level
 * on some resources of one type (servers by name when the org lists them;
 * anything else they can already see, to ask for more).
 */
export function RequestAccessDialog({
  onClose,
  initialServerId,
  initial,
}: {
  onClose: () => void;
  initialServerId?: string;
  initial?: { type: ResourceType; id: string; level?: AccessLevel };
}) {
  const qc = useQueryClient();
  const { data: me } = useMeAccess();
  const { data, isLoading } = useRequestableAccess();
  const { data: servers } = useRequestableServers();
  const start = initial ?? (initialServerId ? { type: 'server' as const, id: initialServerId } : undefined);
  const [kind, setKind] = useState<'resource' | 'role'>('resource');
  const [type, setType] = useState<ResourceType>(start?.type ?? 'server');
  const [selected, setSelected] = useState<Set<string>>(new Set(start ? [start.id] : []));
  const [roleId, setRoleId] = useState('');
  const [level, setLevel] = useState<AccessLevel | null>(start?.level ?? null);
  /** Clusters: the namespaces asked for; null = the whole cluster. */
  const [namespaces, setNamespaces] = useState<string[] | null>(null);
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState<number | null>(null);

  const max = data?.settings.maxRequestMinutes ?? 480;
  const choices = durationChoices(max);
  // Default to 2 hours (or the org maximum, if lower) — ask for what the task needs
  const duration = minutes ?? Math.min(max, 120);
  // A starting point: operate where the member's roles let them operate this kind of resource
  const module = MODULES.find((m) => m.resourceType === type)?.key;
  const effectiveLevel: AccessLevel = level ?? (module && moduleAtLeast(module, me?.modules[module], 'operate') ? 'operate' : 'view');

  const expiry = new Map((servers?.servers ?? []).flatMap((s) => (s.granted?.expiresAt ? [[s.id, s.granted.expiresAt] as const] : [])));
  const ofType = (data?.resources ?? []).filter((r) => r.type === type);
  const types = RESOURCE_SECTIONS.filter((s) => (data?.resources ?? []).some((r) => r.type === s.type));

  const mutation = useMutation({
    mutationFn: (body: CreateAccessRequest) => api.post<AccessRequest>('/access-requests', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['access-requests'] });
      toast.success('Request sent — admins have been notified');
      onClose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  const ready =
    reason.trim().length >= 3 && (kind === 'role' ? !!roleId : selected.size > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <form
        aria-label="Request access"
        onSubmit={(e) => {
          e.preventDefault();
          const common = { reason: reason.trim(), durationMinutes: duration };
          mutation.mutate(
            kind === 'role'
              ? { roleId, ...common }
              : {
                  resourceType: type,
                  resourceIds: [...selected],
                  level: effectiveLevel,
                  ...(type === 'cluster' && namespaces?.length ? { namespaces } : {}),
                  ...common,
                },
          );
        }}
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <KeyRound size={16} className="text-primary shrink-0" />
          <span className="flex-1 truncate text-sm font-semibold">Request access</span>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div className="flex gap-1 rounded-md border border-border p-1 text-sm">
                {(['resource', 'role'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={cn('flex-1 rounded px-3 py-1', kind === k ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                  >
                    {k === 'resource' ? 'Resources' : 'A role'}
                  </button>
                ))}
              </div>

              {kind === 'role' ? (
                <div>
                  <label className="block text-sm font-medium mb-1">Role</label>
                  <div className="rounded-md border border-border divide-y divide-border max-h-60 overflow-y-auto">
                    {!data?.roles.length ? (
                      <p className="px-3 py-4 text-sm text-muted-foreground">This organization has no roles yet.</p>
                    ) : (
                      data.roles.map((r) => {
                        const permanent = r.held?.expiresAt === null;
                        return (
                          <label key={r.id} className="flex items-start gap-2 px-3 py-2 text-sm hover:bg-muted/50">
                            <input type="radio" name="role" className="mt-1" disabled={permanent} checked={roleId === r.id} onChange={() => setRoleId(r.id)} />
                            <span className="flex-1 min-w-0">
                              <span className="flex items-center gap-1.5 font-medium"><RoleDot color={r.color} /> {r.name}</span>
                              {r.description && <span className="block text-xs text-muted-foreground">{r.description}</span>}
                            </span>
                            {permanent && <span className="text-xs text-muted-foreground">You hold it</span>}
                            {r.held?.expiresAt && <ExpiryBadge expiresAt={r.held.expiresAt} />}
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="request-type" className="block text-sm font-medium mb-1">Type</label>
                      <select
                        id="request-type"
                        value={type}
                        onChange={(e) => { setType(e.target.value as ResourceType); setSelected(new Set()); setNamespaces(null); }}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      >
                        {(types.length ? types : RESOURCE_SECTIONS.slice(0, 1)).map((s) => <option key={s.type} value={s.type}>{s.title}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="request-level" className="block text-sm font-medium mb-1">Level</label>
                      <select
                        id="request-level"
                        value={effectiveLevel}
                        onChange={(e) => setLevel(e.target.value as AccessLevel)}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      >
                        {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]} — {LEVEL_HINTS[type][l]}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{RESOURCE_SECTIONS.find((s) => s.type === type)?.title}</label>
                    <div className="rounded-md border border-border divide-y divide-border max-h-60 overflow-y-auto">
                      {ofType.length === 0 ? (
                        <p className="px-3 py-4 text-sm text-muted-foreground">
                          No {RESOURCE_TYPE_LABELS[type].many} to ask for. Ask for a role, or an admin to grant access.
                        </p>
                      ) : (
                        ofType.map((r) => {
                          const has = levelAtLeast(r.level, effectiveLevel) && !expiry.has(r.id);
                          return (
                            <label key={r.id} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50" title={has ? 'You already have this level' : undefined}>
                              <input type="checkbox" disabled={has} checked={has || selected.has(r.id)} onChange={() => toggle(r.id)} />
                              <span className="flex-1 truncate">{r.name}</span>
                              {r.level && <span className="text-xs text-muted-foreground">has {r.level}</span>}
                              {expiry.get(r.id) && <ExpiryBadge expiresAt={expiry.get(r.id)!} />}
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>
                  {type === 'cluster' && (
                    <div data-testid="request-namespaces">
                      <NamespaceChips namespaces={namespaces} onChange={setNamespaces} inputLabel="Add a namespace to ask for" />
                      <p className="mt-1 text-xs text-muted-foreground">
                        Add the namespaces you need, or leave it at all to ask for the whole cluster.
                      </p>
                    </div>
                  )}
                </>
              )}

              <div>
                <label htmlFor="request-duration" className="block text-sm font-medium mb-1">For how long</label>
                <select
                  id="request-duration"
                  value={duration}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  {choices.map((o) => (
                    <option key={o.minutes} value={o.minutes}>{o.label}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Counted from approval. An admin may approve a shorter time. The most you can ask for is {formatMinutes(max)}.
                </p>
              </div>
              <div>
                <label htmlFor="request-reason" className="block text-sm font-medium mb-1">Reason</label>
                <textarea
                  id="request-reason"
                  required
                  minLength={3}
                  maxLength={500}
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="What do you need to do, e.g. a ticket number"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
            Cancel
          </button>
          <button
            type="submit"
            disabled={mutation.isPending || !ready}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {mutation.isPending ? 'Sending…' : 'Send request'}
          </button>
        </div>
      </form>
    </div>
  );
}
