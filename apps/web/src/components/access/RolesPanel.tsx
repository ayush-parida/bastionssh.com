import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccessResources,
  CustomRole,
  CustomRoleDetail,
  OrgMember,
  RoleGrant,
  SaveCustomRole,
} from '@smt/shared';
import { Pencil, Plus, Shield, Trash2, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { DURATION_OPTIONS, LEVEL_LABELS, RESOURCE_TYPE_LABELS } from '@/lib/access.js';
import { ExpiryBadge } from './ExpiryBadge.js';
import { RoleDot } from './AccessBadges.js';
import {
  GrantPreview,
  GrantsEditor,
  toEditable,
  toGrantInputs,
  useAccessResources,
  type EditableGrant,
} from './GrantsEditor.js';

/**
 * Team & Access → Roles (custom roles spec §7): named roles that bundle
 * resources with a level each, and the people who hold them. Admins only —
 * the server refuses everyone else.
 */

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

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
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

/** Members of a role: who, until when; add with an optional expiry, remove. */
function RoleMembers({ role }: { role: CustomRoleDetail }) {
  const qc = useQueryClient();
  const [userId, setUserId] = useState('');
  const [minutes, setMinutes] = useState<number | 'permanent'>('permanent');
  const { data: members } = useQuery<OrgMember[]>({ queryKey: ['team-members'], queryFn: () => api.get('/team/members') });
  const holding = new Set(role.members.map((m) => m.userId));
  const candidates = (members ?? []).filter((m) => !holding.has(m.userId));

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['role', role.id] });
    qc.invalidateQueries({ queryKey: ['roles'] });
    qc.invalidateQueries({ queryKey: ['team-members'] });
  };
  const add = useMutation({
    mutationFn: () =>
      api.post(`/team/roles/${role.id}/members`, {
        userId,
        expiresInMinutes: minutes === 'permanent' ? null : minutes,
      }),
    onSuccess: () => { refresh(); setUserId(''); toast.success('Member added'); },
    onError: (err: Error) => toast.error(err.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/team/roles/${role.id}/members/${id}`),
    onSuccess: () => { refresh(); toast.success('Member removed — what only this role gave them is closed'); },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Members</p>
      <div className="rounded-md border border-border divide-y divide-border">
        {role.members.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground">Nobody holds this role yet.</p>
        ) : (
          role.members.map((m) => (
            <div key={m.userId} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="flex-1 min-w-0 truncate">
                {m.displayName} <span className="text-xs text-muted-foreground">{m.email} · {m.role}</span>
              </span>
              {m.expiresAt ? <ExpiryBadge expiresAt={m.expiresAt} /> : <span className="text-xs text-muted-foreground">Permanent</span>}
              <button
                type="button"
                aria-label={`Remove ${m.email} from the role`}
                onClick={() => remove.mutate(m.userId)}
                className="text-muted-foreground hover:text-red-500"
              >
                <X size={14} />
              </button>
            </div>
          ))
        )}
      </div>
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
    </div>
  );
}

/** Create a role, or edit one: name, colour, description, resources, members, and a preview. */
function RoleEditor({ roleId, onClose }: { roleId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [id, setId] = useState(roleId);
  const { data: resources } = useAccessResources();
  const { data: role } = useQuery<CustomRoleDetail>({
    queryKey: ['role', id],
    queryFn: () => api.get(`/team/roles/${id}`),
    enabled: !!id,
  });
  // Local edits win; until the first edit, show what the server has
  const [form, setForm] = useState<{ name: string; description: string; color: string } | null>(null);
  const [grants, setGrants] = useState<EditableGrant[] | null>(null);
  const current = form ?? { name: role?.name ?? '', description: role?.description ?? '', color: role?.color ?? COLORS[0]! };
  const currentGrants = grants ?? (role ? toEditable(role.grants) : []);

  const save = useMutation({
    mutationFn: async () => {
      const body: SaveCustomRole = { name: current.name.trim(), description: current.description.trim() || null, color: current.color };
      if (!id) {
        return api.post<CustomRoleDetail>('/team/roles', { ...body, grants: toGrantInputs(currentGrants) });
      }
      if (form) await api.patch(`/team/roles/${id}`, body);
      if (grants) await api.put(`/team/roles/${id}/grants`, { grants: toGrantInputs(currentGrants) });
      return null;
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      qc.invalidateQueries({ queryKey: ['role', id] });
      setForm(null);
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
  const dirty = !id || !!form || !!grants;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div role="dialog" aria-label={id ? `Role ${current.name}` : 'New role'} className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Shield size={16} className="text-primary shrink-0" />
          <span className="flex-1 truncate text-sm font-semibold">{id ? `Role — ${role?.name ?? ''}` : 'New role'}</span>
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
                  <input id="role-name" value={current.name} maxLength={60} onChange={(e) => setForm({ ...current, name: e.target.value })} placeholder="Web team" className={inputClass} />
                </div>
                <div>
                  <span className="block text-sm font-medium mb-1">Colour</span>
                  <div className="flex gap-1.5 py-1.5">
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={`Colour ${c}`}
                        onClick={() => setForm({ ...current, color: c })}
                        className={`size-6 rounded-full border-2 ${current.color === c ? 'border-foreground' : 'border-transparent'}`}
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="role-description" className="block text-sm font-medium mb-1">Description</label>
                  <input id="role-description" value={current.description} maxLength={500} onChange={(e) => setForm({ ...current, description: e.target.value })} placeholder="What the role is for" className={inputClass} />
                </div>
              </div>
              <div>
                <p className="mb-1 text-sm font-semibold">Resources</p>
                <p className="mb-3 text-xs text-muted-foreground">
                  Members get each level on these resources on top of their base role — it can raise a viewer to operate here,
                  and never grants team, SSO, backups, keys or other organization settings.
                </p>
                <GrantsEditor grants={currentGrants} onChange={setGrants} resources={resources} />
              </div>
              <GrantPreview grants={currentGrants} resources={resources} />
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
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || loading || !dirty || !current.name.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : id ? 'Save changes' : 'Create role'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RolesPanel() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const { data: roles, isLoading } = useQuery<CustomRole[]>({ queryKey: ['roles'], queryFn: () => api.get('/team/roles') });
  const { data: resources } = useAccessResources();

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/team/roles/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      qc.invalidateQueries({ queryKey: ['team-members'] });
      toast.success('Role deleted — its members lost what it gave them');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <section>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold">Roles</h2>
        <button
          onClick={() => setEditing(null)}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus size={14} /> New role
        </button>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Bundle servers, clusters, connections, commands and cron jobs with a level each, then add people. Members limited to
        &ldquo;only resources from roles&rdquo; see nothing else; others get these levels on top of their base role.
      </p>
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
            <div key={r.id} className="flex items-start gap-3 px-4 py-3">
              <RoleDot color={r.color} />
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-sm font-medium">
                  {r.name}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {r.memberCount ?? 0} member{r.memberCount === 1 ? '' : 's'}
                  </span>
                </p>
                {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
                <div className="flex flex-wrap gap-1">
                  {(r.grants ?? []).length === 0 ? (
                    <span className="text-xs text-muted-foreground">No resources</span>
                  ) : (
                    (r.grants ?? []).map((g) => (
                      <span key={g.id} className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{grantChip(g, resources)}</span>
                    ))
                  )}
                </div>
              </div>
              <button onClick={() => setEditing(r.id)} aria-label={`Edit role ${r.name}`} className="text-muted-foreground hover:text-foreground"><Pencil size={14} /></button>
              <button
                onClick={() => { if (confirm(`Delete the ${r.name} role? Its members lose what it gave them, now.`)) remove.mutate(r.id); }}
                aria-label={`Delete role ${r.name}`}
                className="text-red-500 hover:text-red-600"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>
      {editing !== undefined && <RoleEditor roleId={editing} onClose={() => setEditing(undefined)} />}
    </section>
  );
}
