import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CustomRole, MemberScope, MemberServerAccess, OrgMember } from '@smt/shared';
import { ServerCog, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { DURATION_OPTIONS, RESOURCE_SECTIONS } from '@/lib/access.js';
import { ExpiryBadge } from './ExpiryBadge.js';
import { LevelBadge, RoleDot, ViaBadge } from './AccessBadges.js';
import { GrantPreview, GrantsEditor, toEditable, toGrantInputs, useAccessResources, type EditableGrant } from './GrantsEditor.js';

/**
 * Member detail (custom roles spec §7): base role, scope ("All resources" /
 * "Only resources from roles"), roles held with their expiry, personal
 * grants, and the effective access on every resource with where it comes
 * from. Admins only; owners and admins always manage everything.
 */
export default function MemberAccessDialog({ member, onClose }: { member: OrgMember; onClose: () => void }) {
  const qc = useQueryClient();
  const privileged = member.role === 'admin' || member.role === 'owner';
  const { data: access, isLoading } = useQuery<MemberServerAccess>({
    queryKey: ['member-access', member.userId],
    queryFn: () => api.get(`/team/members/${member.userId}/access`),
  });
  const { data: roles } = useQuery<CustomRole[]>({ queryKey: ['roles'], queryFn: () => api.get('/team/roles') });
  const { data: resources } = useAccessResources();
  const [grants, setGrants] = useState<EditableGrant[] | null>(null);
  const [roleToAdd, setRoleToAdd] = useState('');
  const [roleMinutes, setRoleMinutes] = useState<number | 'permanent'>('permanent');

  const currentGrants = grants ?? toEditable(access?.personalGrants ?? []);
  const roleColor = new Map((roles ?? []).map((r) => [r.id, r.color]));
  const held = new Set((access?.roles ?? []).map((r) => r.roleId));

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['member-access', member.userId] });
    qc.invalidateQueries({ queryKey: ['team-members'] });
    qc.invalidateQueries({ queryKey: ['roles'] });
  };

  const scopeMutation = useMutation({
    mutationFn: (scope: MemberScope) => api.patch(`/team/members/${member.userId}`, { scope }),
    onSuccess: () => { refresh(); toast.success('Scope updated'); },
    onError: (err: Error) => toast.error(err.message),
  });
  const grantsMutation = useMutation({
    mutationFn: () => api.put(`/team/members/${member.userId}/grants`, { grants: toGrantInputs(currentGrants) }),
    onSuccess: () => { setGrants(null); refresh(); toast.success('Personal grants saved'); },
    onError: (err: Error) => toast.error(err.message),
  });
  const addRole = useMutation({
    mutationFn: () =>
      api.post(`/team/roles/${roleToAdd}/members`, {
        userId: member.userId,
        expiresInMinutes: roleMinutes === 'permanent' ? null : roleMinutes,
      }),
    onSuccess: () => { setRoleToAdd(''); refresh(); toast.success('Role added'); },
    onError: (err: Error) => toast.error(err.message),
  });
  const removeRole = useMutation({
    mutationFn: (roleId: string) => api.delete(`/team/roles/${roleId}/members/${member.userId}`),
    onSuccess: () => { refresh(); toast.success('Role removed — what only it gave is closed'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const scope = access?.scope ?? 'all';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div role="dialog" aria-label={`Access — ${member.displayName}`} className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <ServerCog size={16} className="text-primary shrink-0" />
          <span className="flex-1 truncate text-sm font-semibold">Access — {member.displayName}</span>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {isLoading || !access ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              <section className="space-y-2">
                <p className="text-sm">
                  Base role <span className="rounded bg-muted px-2 py-0.5 text-xs capitalize">{access.role ?? member.role}</span>
                  <span className="ml-2 text-xs text-muted-foreground">controls organization features; roles below only add resource levels.</span>
                </p>
                {privileged ? (
                  <p className="text-sm text-muted-foreground">Owners and admins always manage every resource.</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {([
                      ['all', 'All resources', `Their base role (${member.role}) on everything, plus what roles add.`],
                      ['roles', 'Only resources from roles', 'Everything else is hidden — lists, terminals, files, commands, cron, clusters.'],
                    ] as const).map(([value, label, hint]) => (
                      <label key={value} className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', scope === value ? 'border-primary bg-primary/5' : 'border-border')}>
                        <input
                          type="radio"
                          name="scope"
                          className="mt-1"
                          checked={scope === value}
                          disabled={scopeMutation.isPending}
                          onChange={() => scopeMutation.mutate(value)}
                        />
                        <span>
                          <span className="font-medium">{label}</span>
                          <span className="block text-xs text-muted-foreground">{hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </section>

              <section className="space-y-2">
                <p className="text-sm font-semibold">Roles</p>
                <div className="flex flex-wrap gap-2">
                  {(access.roles ?? []).length === 0 && <span className="text-sm text-muted-foreground">No roles.</span>}
                  {(access.roles ?? []).map((r) => (
                    <span key={r.roleId} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-sm">
                      <RoleDot color={r.color} /> {r.name}
                      {r.expiresAt && <ExpiryBadge expiresAt={r.expiresAt} />}
                      <button aria-label={`Remove role ${r.name}`} onClick={() => removeRole.mutate(r.roleId)} className="text-muted-foreground hover:text-red-500">
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select aria-label="Role to add" value={roleToAdd} onChange={(e) => setRoleToAdd(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5 text-sm">
                    <option value="">Add to a role…</option>
                    {(roles ?? []).filter((r) => !held.has(r.id)).map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                  <select aria-label="Role lasts" value={String(roleMinutes)} onChange={(e) => setRoleMinutes(e.target.value === 'permanent' ? 'permanent' : Number(e.target.value))} className="rounded-md border border-input bg-background px-2 py-1.5 text-sm">
                    <option value="permanent">Permanent</option>
                    {DURATION_OPTIONS.map((o) => <option key={o.minutes} value={o.minutes}>For {o.label}</option>)}
                  </select>
                  <button disabled={!roleToAdd || addRole.isPending} onClick={() => addRole.mutate()} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50">
                    Add
                  </button>
                </div>
              </section>

              {!privileged && (
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">Personal grants</p>
                    <button
                      onClick={() => grantsMutation.mutate()}
                      disabled={!grants || grantsMutation.isPending}
                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                      {grantsMutation.isPending ? 'Saving…' : 'Save personal grants'}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">Just for this member, on top of their roles. Good for a one-off or time-bound need.</p>
                  <GrantsEditor grants={currentGrants} onChange={setGrants} resources={resources} />
                  {grants && <GrantPreview grants={currentGrants} resources={resources} subject={member.displayName} />}
                </section>
              )}

              <section className="space-y-2">
                <p className="text-sm font-semibold">Effective access</p>
                <p className="text-xs text-muted-foreground">Every resource they can reach right now, at which level, and why.</p>
                {RESOURCE_SECTIONS.map(({ type, title }) => {
                  const entries = access.effective?.[type] ?? [];
                  if (!entries.length) return null;
                  return (
                    <div key={type} data-testid={`effective-${type}`}>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p>
                      <div className="rounded-md border border-border divide-y divide-border">
                        {entries.map((e) => (
                          <div key={e.resourceId} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
                            <span className="min-w-0 flex-1 truncate">
                              {e.name}
                              {e.namespaces && e.namespaces.length > 0 && (
                                <span className="ml-2 font-mono text-xs text-muted-foreground">ns: {e.namespaces.join(', ')}</span>
                              )}
                            </span>
                            <LevelBadge level={e.level} />
                            {e.via.map((v, i) => <ViaBadge key={i} reason={v} color={v.roleId ? roleColor.get(v.roleId) : null} />)}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {RESOURCE_SECTIONS.every(({ type }) => !(access.effective?.[type] ?? []).length) && (
                  <p className="text-sm text-muted-foreground">Nothing — they cannot see any resource.</p>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
