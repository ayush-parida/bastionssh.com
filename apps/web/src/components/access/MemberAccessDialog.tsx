import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MODULES, type CustomRole, type MemberServerAccess, type ModuleLevel, type OrgMember } from '@smt/shared';
import { ServerCog, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { useModule } from '@/hooks/useModules.js';
import { useAuthStore } from '@/store/auth.js';
import { DURATION_OPTIONS, RESOURCE_SECTIONS } from '@/lib/access.js';
import { ExpiryBadge } from './ExpiryBadge.js';
import { LevelBadge, RoleDot, ViaBadge } from './AccessBadges.js';
import { GrantPreview, GrantsEditor, toEditable, toGrantInputs, useAccessResources, type EditableGrant } from './GrantsEditor.js';

/**
 * Member detail (unified roles spec §5): the roles they hold, as chips —
 * add one (optionally for a while), take one away — their personal grants,
 * and the effective access: every module with its level and the roles giving
 * it, then every resource they reach with its level and why. Someone holding
 * no role (or only No access) has nothing but their own account. Roles the
 * viewer could not give themselves are not offered (the server refuses them
 * too).
 */

const MODULE_LABELS = new Map(MODULES.map((m) => [m.key, m.label]));

const MODULE_LEVEL_LABELS: Record<Exclude<ModuleLevel, 'none'>, string> = { view: 'View', operate: 'Operate', manage: 'Manage' };

export default function MemberAccessDialog({ member, onClose }: { member: OrgMember; onClose: () => void }) {
  const qc = useQueryClient();
  const canAssign = useModule('team_roles', 'manage');
  const isSelf = useAuthStore((s) => s.user?.id) === member.userId;
  const { data: access, isLoading } = useQuery<MemberServerAccess>({
    queryKey: ['member-access', member.userId],
    queryFn: () => api.get(`/team/members/${member.userId}/access`),
  });
  const { data: roles } = useQuery<CustomRole[]>({ queryKey: ['roles'], queryFn: () => api.get('/team/roles') });
  const { data: resources } = useAccessResources();
  const [grants, setGrants] = useState<EditableGrant[] | null>(null);
  const [roleToAdd, setRoleToAdd] = useState('');
  const [roleMinutes, setRoleMinutes] = useState<number | 'permanent'>('permanent');

  const held = access?.roles ?? [];
  const isOwner = held.some((r) => r.system === 'owner');
  const currentGrants = grants ?? toEditable(access?.personalGrants ?? []);
  const roleById = new Map((roles ?? []).map((r) => [r.id, r]));
  const heldIds = new Set(held.map((r) => r.roleId));
  // Your own access is not yours to change; others' only with roles you could give
  const editable = canAssign && !isSelf;
  const addable = (roles ?? []).filter((r) => !heldIds.has(r.id) && r.assignable);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['member-access', member.userId] });
    qc.invalidateQueries({ queryKey: ['team-members'] });
    qc.invalidateQueries({ queryKey: ['roles'] });
  };

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

  const modules = (access?.modules ?? []).filter((m) => m.level !== 'none');

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
                <p className="text-sm font-semibold">Roles</p>
                <p className="text-xs text-muted-foreground">
                  They get the most any of their roles gives. With none, they see nothing but their own account.
                </p>
                <div className="flex flex-wrap gap-2" data-testid="member-roles">
                  {held.length === 0 && (
                    <span className="rounded-md border border-dashed border-border px-2 py-1 text-sm text-muted-foreground">No access</span>
                  )}
                  {held.map((r) => (
                    <span key={r.roleId} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-sm">
                      <RoleDot color={r.color} /> {r.name}
                      {r.system && <span className="text-[11px] text-muted-foreground">built-in</span>}
                      {r.expiresAt && <ExpiryBadge expiresAt={r.expiresAt} />}
                      {editable && roleById.get(r.roleId)?.assignable && (
                        <button aria-label={`Remove role ${r.name}`} onClick={() => removeRole.mutate(r.roleId)} className="text-muted-foreground hover:text-red-500">
                          <X size={12} />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
                {editable && (
                  <div className="flex flex-wrap items-center gap-2">
                    <select aria-label="Role to add" value={roleToAdd} onChange={(e) => setRoleToAdd(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5 text-sm">
                      <option value="">Add a role…</option>
                      {addable.map((r) => (
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
                )}
              </section>

              {!isOwner && editable && (
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
                  <p className="text-xs text-muted-foreground">
                    Just for this member, on top of their roles. Good for a one-off or time-bound need. A grant counts while
                    one of their roles has its module on.
                  </p>
                  <GrantsEditor grants={currentGrants} onChange={setGrants} resources={resources} />
                  {grants && <GrantPreview grants={currentGrants} resources={resources} subject={member.displayName} />}
                </section>
              )}

              <section className="space-y-2">
                <p className="text-sm font-semibold">Effective access</p>
                <p className="text-xs text-muted-foreground">What they can use and reach right now, at which level, and why.</p>

                <div data-testid="effective-modules">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Modules</p>
                  {modules.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None — only their own account.</p>
                  ) : (
                    <div className="rounded-md border border-border divide-y divide-border">
                      {modules.map((m) => (
                        <div key={m.module} className={cn('flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm', !m.visible && 'opacity-70')}>
                          <span className="min-w-0 flex-1 truncate">
                            {MODULE_LABELS.get(m.module) ?? m.module}
                            {!m.visible && <span className="ml-2 text-xs text-muted-foreground">hidden — nothing in it for them</span>}
                          </span>
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
                            {MODULE_LEVEL_LABELS[m.level as Exclude<ModuleLevel, 'none'>]}
                          </span>
                          {m.via.map((v) => (
                            <span key={v.roleId} className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-xs">
                              <RoleDot color={roleById.get(v.roleId)?.color} /> via {v.name}
                              <span className="text-muted-foreground">· {v.level}</span>
                            </span>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

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
                            {e.via.map((v, i) => <ViaBadge key={i} reason={v} color={v.roleId ? roleById.get(v.roleId)?.color : null} />)}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {RESOURCE_SECTIONS.every(({ type }) => !(access.effective?.[type] ?? []).length) && (
                  <p className="text-sm text-muted-foreground">No resources — they cannot see any server, cluster or connection.</p>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
