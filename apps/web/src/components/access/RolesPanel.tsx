import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MODULES,
  type AccessResources,
  type CustomRole,
  type CustomRoleDetail,
  type DefaultRole,
  type ModuleKey,
  type ModulePermissions,
  type OrgMember,
  type RoleGrant,
  type SaveCustomRole,
} from '@smt/shared';
import { Copy, Eye, Pencil, Plus, RotateCcw, Shield, Trash2, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { useAuthStore } from '@/store/auth.js';
import { useModule } from '@/hooks/useModules.js';
import { DURATION_OPTIONS, LEVEL_LABELS, RESOURCE_TYPE_LABELS } from '@/lib/access.js';
import { ExpiryBadge } from './ExpiryBadge.js';
import { RoleDot } from './AccessBadges.js';
import { ModulesGrid } from './ModulesGrid.js';
import {
  GrantPreview,
  GrantsEditor,
  toEditable,
  toGrantInputs,
  useAccessResources,
  type EditableGrant,
} from './GrantsEditor.js';

/**
 * Team & Access → Roles (unified roles spec §5): every role of the org, the
 * built-in ones first. A role is a named bundle of module levels (what
 * features its members use) and resources (which items they reach). Owner
 * and No access are locked; Admin, Operator and Viewer can be edited and
 * reset to their defaults; any role but Owner can be cloned. The server
 * refuses anything the editor's own roles do not hold (the delegation guard).
 */

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

const MODULE_LABELS = new Map(MODULES.map((m) => [m.key, m.label]));

/** The resource module whose level decides whether grants of a type count (as the server's TYPE_MODULES). */
const TYPE_MODULE: Record<RoleGrant['resourceType'], ModuleKey> = {
  server: 'servers',
  cluster: 'kubernetes',
  ftp_connection: 'ftp',
  storage_connection: 'storage',
  cloud_account: 'cloud',
  saved_command: 'saved_commands',
  cron_job: 'cron_jobs',
};

/** "web-1 · operate", "tag frontend · operate", "All clusters · view". */
function grantChip(g: RoleGrant, resources: AccessResources | undefined): string {
  const labels = RESOURCE_TYPE_LABELS[g.resourceType];
  const what =
    g.selector === 'all'
      ? `All ${labels.many}`
      : g.selector === 'tag'
        ? `tag ${g.tag}`
        : (resources?.[g.resourceType].find((r) => r.id === g.resourceId)?.name ?? labels.one);
  const ns = g.namespaces?.length ? ` (ns: ${g.namespaces.join(', ')})` : '';
  return `${what}${ns} · ${LEVEL_LABELS[g.level].toLowerCase()}`;
}

const inputClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60';

/** Small labels next to a role's name: what kind of role it is. */
export function RoleBadges({ role }: { role: Pick<CustomRole, 'system' | 'editable' | 'customized' | 'generated'> }) {
  return (
    <>
      {role.system && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">Built-in</span>}
      {role.editable === false && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">Locked</span>}
      {role.system && role.editable && role.customized && (
        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">Customized</span>
      )}
      {role.generated && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">From migration</span>}
    </>
  );
}

/** Refetch what a role change can touch: roles, members, and the caller's own modules (they may hold it). */
function useRefreshRoles() {
  const qc = useQueryClient();
  return (roleId?: string | null) => {
    qc.invalidateQueries({ queryKey: ['roles'] });
    if (roleId) qc.invalidateQueries({ queryKey: ['role', roleId] });
    qc.invalidateQueries({ queryKey: ['team-members'] });
    qc.invalidateQueries({ queryKey: ['member-access'] });
    qc.invalidateQueries({ queryKey: ['me-access'] });
    qc.invalidateQueries({ queryKey: ['me-modules'] });
  };
}

/** Members of a role: who, until when; add with an optional expiry, remove. */
function RoleMembers({ role }: { role: CustomRoleDetail }) {
  const refresh = useRefreshRoles();
  const [userId, setUserId] = useState('');
  const [minutes, setMinutes] = useState<number | 'permanent'>('permanent');
  const { data: members } = useQuery<OrgMember[]>({ queryKey: ['team-members'], queryFn: () => api.get('/team/members') });
  const holding = new Set(role.members.map((m) => m.userId));
  const myId = useAuthStore((s) => s.user?.id);
  // Your own access is not yours to change (the server refuses it too)
  const candidates = (members ?? []).filter((m) => !holding.has(m.userId) && m.userId !== myId);
  // Giving or taking the role needs everything it gives (and Owner, an owner)
  const canAssign = role.assignable !== false;

  const add = useMutation({
    mutationFn: () =>
      api.post(`/team/roles/${role.id}/members`, {
        userId,
        expiresInMinutes: minutes === 'permanent' ? null : minutes,
      }),
    onSuccess: () => { refresh(role.id); setUserId(''); toast.success('Member added'); },
    onError: (err: Error) => toast.error(err.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/team/roles/${role.id}/members/${id}`),
    onSuccess: () => { refresh(role.id); toast.success('Member removed — what only this role gave them is closed'); },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold">Members</p>
      <div className="rounded-md border border-border divide-y divide-border">
        {role.members.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground">Nobody holds this role yet.</p>
        ) : (
          role.members.map((m) => (
            <div key={m.userId} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="flex-1 min-w-0 truncate">
                {m.displayName} <span className="text-xs text-muted-foreground">{m.email}</span>
              </span>
              {m.expiresAt ? <ExpiryBadge expiresAt={m.expiresAt} /> : <span className="text-xs text-muted-foreground">Permanent</span>}
              {canAssign && m.userId !== myId && (
                <button
                  type="button"
                  aria-label={`Remove ${m.email} from the role`}
                  onClick={() => remove.mutate(m.userId)}
                  className="text-muted-foreground hover:text-red-500"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
      {canAssign ? (
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Member to add" value={userId} onChange={(e) => setUserId(e.target.value)} className="flex-1 min-w-40 rounded-md border border-input bg-background px-2 py-1.5 text-sm">
            <option value="">Add a member…</option>
            {candidates.map((m) => (
              <option key={m.userId} value={m.userId}>{m.displayName} ({m.email})</option>
            ))}
          </select>
          <select
            aria-label="Membership lasts"
            value={String(minutes)}
            onChange={(e) => setMinutes(e.target.value === 'permanent' ? 'permanent' : Number(e.target.value))}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          >
            <option value="permanent">Permanent</option>
            {DURATION_OPTIONS.map((o) => (
              <option key={o.minutes} value={o.minutes}>For {o.label}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={!userId || add.isPending}
            onClick={() => add.mutate()}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            <UserPlus size={13} /> Add member
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {role.system === 'owner' ? 'Only an owner gives or takes the Owner role.' : 'You can give this role only once you hold everything it gives.'}
        </p>
      )}
    </div>
  );
}

/** Create a role, or edit one: name, colour, description, modules, resources, members, and a preview. */
function RoleEditor({ roleId, onClose }: { roleId: string | null; onClose: () => void }) {
  const refresh = useRefreshRoles();
  const canManage = useModule('team_roles', 'manage');
  const [id, setId] = useState(roleId);
  const { data: resources } = useAccessResources();
  const { data: role } = useQuery<CustomRoleDetail>({
    queryKey: ['role', id],
    queryFn: () => api.get(`/team/roles/${id}`),
    enabled: !!id,
  });
  // Local edits win; until the first edit, show what the server has
  const [form, setForm] = useState<{ name: string; description: string; color: string } | null>(null);
  const [modules, setModules] = useState<ModulePermissions | null>(null);
  const [grants, setGrants] = useState<EditableGrant[] | null>(null);
  const current = form ?? { name: role?.name ?? '', description: role?.description ?? '', color: role?.color ?? COLORS[0]! };
  const currentModules = modules ?? role?.modulePermissions ?? {};
  const currentGrants = grants ?? (role ? toEditable(role.grants) : []);
  const locked = role?.editable === false || !canManage;
  const builtIn = !!role?.system;
  // Grants of a type whose module is off count for nothing until it is on (spec §10.4)
  const parked = new Set(currentGrants.map((g) => TYPE_MODULE[g.resourceType]).filter((m) => !currentModules[m]));

  /** New resources turn their module on at View when it is off, so they count. */
  function changeGrants(next: EditableGrant[]) {
    const before = new Set(currentGrants.map((g) => g.resourceType));
    const added = next.filter((g) => !before.has(g.resourceType)).map((g) => TYPE_MODULE[g.resourceType]);
    const enable = added.filter((m) => !currentModules[m]);
    if (enable.length) {
      const nextModules = { ...currentModules };
      for (const m of enable) {
        nextModules[m] = 'view';
        // Containers are a view over servers
        if (m === 'servers' && !nextModules.containers) nextModules.containers = 'view';
      }
      setModules(nextModules);
    }
    setGrants(next);
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!id) {
        const body: SaveCustomRole = {
          name: current.name.trim(),
          description: current.description.trim() || null,
          color: current.color,
          modulePermissions: currentModules,
          grants: toGrantInputs(currentGrants),
        };
        return api.post<CustomRoleDetail>('/team/roles', body);
      }
      if (form || modules) {
        const body: SaveCustomRole = {
          // Built-ins keep their names
          ...(!builtIn && form && { name: current.name.trim() }),
          ...(form && { description: current.description.trim() || null, color: current.color }),
          ...(modules && { modulePermissions: modules }),
        };
        await api.patch(`/team/roles/${id}`, body);
      }
      if (grants) await api.put(`/team/roles/${id}/grants`, { grants: toGrantInputs(currentGrants) });
      return null;
    },
    onSuccess: (created) => {
      refresh(id);
      setForm(null);
      setModules(null);
      setGrants(null);
      if (created) {
        // Straight on to adding members
        setId(created.id);
        toast.success('Role created — now add its members');
      } else {
        toast.success('Role saved');
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const loading = !!id && !role;
  const dirty = !id || !!form || !!modules || !!grants;
  const title = id ? `Role ${role?.name ?? ''}` : 'New role';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div role="dialog" aria-label={title} className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Shield size={16} className="text-primary shrink-0" />
          <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-sm font-semibold">
            {id ? `Role — ${role?.name ?? ''}` : 'New role'}
            {role && <RoleBadges role={role} />}
          </span>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="role-name" className="block text-sm font-medium mb-1">Name</label>
                  <input id="role-name" value={current.name} maxLength={60} disabled={locked || builtIn} onChange={(e) => setForm({ ...current, name: e.target.value })} placeholder="Web team" className={inputClass} />
                </div>
                <div>
                  <span className="block text-sm font-medium mb-1">Colour</span>
                  <div className="flex gap-1.5 py-1.5">
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={`Colour ${c}`}
                        disabled={locked}
                        onClick={() => setForm({ ...current, color: c })}
                        className={`size-6 rounded-full border-2 ${current.color === c ? 'border-foreground' : 'border-transparent'}`}
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="role-description" className="block text-sm font-medium mb-1">Description</label>
                  <input id="role-description" value={current.description} maxLength={500} disabled={locked} onChange={(e) => setForm({ ...current, description: e.target.value })} placeholder="What the role is for" className={inputClass} />
                </div>
              </div>

              <div>
                <p className="mb-1 text-sm font-semibold">Modules</p>
                <p className="mb-3 text-xs text-muted-foreground">
                  {role?.system === 'owner'
                    ? 'Owners have every module, and the owner-only actions: ownership, backups, deleting the organization.'
                    : role?.system === 'none'
                      ? 'Members with only this role see nothing but their own account.'
                      : 'What its members may use. A member holding several roles gets the highest level any of them gives; a module nobody gives them is hidden.'}
                </p>
                <ModulesGrid value={currentModules} onChange={setModules} readOnly={locked} parked={parked} />
              </div>

              <div>
                <p className="mb-1 text-sm font-semibold">Resources</p>
                {role?.system === 'owner' ? (
                  <p className="text-sm text-muted-foreground">Every resource, managed — always.</p>
                ) : role?.system === 'none' ? (
                  <p className="text-sm text-muted-foreground">None.</p>
                ) : (
                  <>
                    <p className="mb-3 text-xs text-muted-foreground">
                      Which servers, clusters, connections, commands and cron jobs its members reach, and at which level.
                    </p>
                    {locked ? (
                      <div className="flex flex-wrap gap-1">
                        {currentGrants.length === 0 && <span className="text-xs text-muted-foreground">No resources</span>}
                        {(role?.grants ?? []).map((g) => (
                          <span key={g.id} className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{grantChip(g, resources)}</span>
                        ))}
                      </div>
                    ) : (
                      <GrantsEditor grants={currentGrants} onChange={changeGrants} resources={resources} />
                    )}
                  </>
                )}
              </div>
              {role?.system !== 'owner' && role?.system !== 'none' && <GrantPreview grants={currentGrants} resources={resources} />}
              {id && role ? (
                <RoleMembers role={role} />
              ) : (
                <p className="text-xs text-muted-foreground">Create the role to add its members.</p>
              )}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">Close</button>
          {!locked && (
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending || loading || !dirty || !current.name.trim()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : id ? 'Save changes' : 'Create role'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Organization settings: the role new members get when an invite or SSO picks none. */
function DefaultRolePicker({ roles }: { roles: CustomRole[] }) {
  const qc = useQueryClient();
  const { data } = useQuery<DefaultRole>({ queryKey: ['default-role'], queryFn: () => api.get('/team/default-role') });
  const change = useMutation({
    mutationFn: (roleId: string) => api.put<DefaultRole>('/team/default-role', { roleId }),
    onSuccess: (res) => {
      qc.setQueryData(['default-role'], res);
      toast.success(`New members now get ${res.name}`);
    },
    onError: (err: Error) => toast.error(err.message),
  });
  return (
    <label className="mb-4 flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">Default role for new members</span>
      <select
        aria-label="Default role for new members"
        value={data?.roleId ?? ''}
        onChange={(e) => change.mutate(e.target.value)}
        className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
      >
        {roles
          .filter((r) => r.system !== 'owner' && r.assignable !== false)
          .map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
      </select>
      <span className="text-xs text-muted-foreground">Invites and single sign-on use it when no role is picked.</span>
    </label>
  );
}

/** "Servers · operate", for the list. */
function moduleChips(modules: ModulePermissions | undefined): string[] {
  return Object.entries(modules ?? {}).map(([key, level]) => `${MODULE_LABELS.get(key as ModuleKey) ?? key} · ${level}`);
}

export default function RolesPanel() {
  const refresh = useRefreshRoles();
  const canManage = useModule('team_roles', 'manage');
  const setsDefault = useModule('settings', 'manage');
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const { data: roles, isLoading } = useQuery<CustomRole[]>({ queryKey: ['roles'], queryFn: () => api.get('/team/roles') });
  const { data: resources } = useAccessResources();

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/team/roles/${id}`),
    onSuccess: () => { refresh(); toast.success('Role deleted — its members lost what it gave them'); },
    onError: (err: Error) => toast.error(err.message),
  });
  const reset = useMutation({
    mutationFn: (id: string) => api.post(`/team/roles/${id}/reset`),
    onSuccess: (_res, id) => { refresh(id); toast.success('Back to its defaults'); },
    onError: (err: Error) => toast.error(err.message),
  });
  const clone = useMutation({
    mutationFn: (id: string) => api.post<CustomRoleDetail>(`/team/roles/${id}/clone`),
    onSuccess: (created) => { refresh(); setEditing(created.id); toast.success(`Cloned as ${created.name}`); },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <section>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold">Roles</h2>
        {canManage && (
          <button
            onClick={() => setEditing(null)}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus size={14} /> New role
          </button>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        A role bundles modules — what its members may use — with resources — which items they reach. Members can hold
        several roles and get the most any of them gives; someone holding only No access sees nothing but their account.
      </p>
      {setsDefault && roles && <DefaultRolePicker roles={roles} />}
      <div className="rounded-lg border border-border bg-card divide-y divide-border">
        {isLoading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
        ) : !roles?.length ? (
          <div className="flex flex-col items-center py-10 text-muted-foreground">
            <Shield size={32} className="mb-2 opacity-30" />
            <p className="text-sm">No roles yet.</p>
          </div>
        ) : (
          roles.map((r) => (
            <div key={r.id} className="flex items-start gap-3 px-4 py-3" data-testid="role-row">
              <RoleDot color={r.color} />
              <div className="flex-1 min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {r.name}
                  <RoleBadges role={r} />
                  <span className="text-xs font-normal text-muted-foreground">
                    {r.memberCount ?? 0} member{r.memberCount === 1 ? '' : 's'}
                  </span>
                </p>
                {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
                {r.system === 'owner' ? (
                  <p className="text-xs text-muted-foreground">Everything</p>
                ) : moduleChips(r.modulePermissions).length === 0 && (r.grants ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nothing</p>
                ) : (
                  <>
                    {/* Labelled apart: what members may use, then which items they reach */}
                    {moduleChips(r.modulePermissions).length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">Modules</span>
                        {moduleChips(r.modulePermissions).map((chip) => (
                          <span key={chip} className="rounded bg-primary/5 px-1.5 py-0.5 text-xs text-foreground/80">{chip}</span>
                        ))}
                      </div>
                    )}
                    {(r.grants ?? []).length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">Resources</span>
                        {(r.grants ?? []).map((g) => (
                          <span key={g.id} className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{grantChip(g, resources)}</span>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
              <button
                onClick={() => setEditing(r.id)}
                aria-label={`${r.editable === false || !canManage ? 'View' : 'Edit'} role ${r.name}`}
                title={r.editable === false || !canManage ? 'View' : 'Edit'}
                className="text-muted-foreground hover:text-foreground"
              >
                {r.editable === false || !canManage ? <Eye size={14} /> : <Pencil size={14} />}
              </button>
              {canManage && r.system !== 'owner' && (
                <button onClick={() => clone.mutate(r.id)} aria-label={`Clone role ${r.name}`} title="Clone" className="text-muted-foreground hover:text-foreground">
                  <Copy size={14} />
                </button>
              )}
              {canManage && r.system && r.editable && r.customized && (
                <button
                  onClick={() => { if (confirm(`Reset ${r.name} to its defaults? Its members get exactly what it gave out of the box.`)) reset.mutate(r.id); }}
                  aria-label={`Reset role ${r.name} to default`}
                  title="Reset to default"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <RotateCcw size={14} />
                </button>
              )}
              {canManage && !r.system && (
                <button
                  onClick={() => { if (confirm(`Delete the ${r.name} role? Its members lose what it gave them, now.`)) remove.mutate(r.id); }}
                  aria-label={`Delete role ${r.name}`}
                  title="Delete"
                  className="text-red-500 hover:text-red-600"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
      {editing !== undefined && <RoleEditor roleId={editing} onClose={() => setEditing(undefined)} />}
    </section>
  );
}
