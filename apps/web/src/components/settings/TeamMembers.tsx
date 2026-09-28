import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { isPasskeyCancel, passkeyErrorMessage, withStepUp } from '@/lib/passkeys.js';
import { cn, relativeTime } from '@/lib/utils.js';
import { useAuthStore, useHasRole } from '@/store/auth.js';
import type {
  OrgMember,
  Invite,
  CreatedInvite,
  MemberServerAccess,
  PasswordResetLink,
  Role,
  Server,
} from '@smt/shared';
import {
  Plus,
  Trash2,
  UserPlus,
  Users,
  Copy,
  Clock,
  X,
  TriangleAlert,
  UserX,
  UserCheck,
  ServerCog,
  KeyRound,
  LogOut,
  Fingerprint,
} from 'lucide-react';
import { toast } from 'sonner';

const ROLE_OPTIONS: { value: Role; label: string; hint: string }[] = [
  { value: 'viewer', label: 'Viewer', hint: 'Read-only access' },
  { value: 'operator', label: 'Operator', hint: 'Run commands and manage cron jobs' },
  { value: 'admin', label: 'Admin', hint: 'Manage servers, keys and people' },
  { value: 'owner', label: 'Owner', hint: 'Full control of the organization' },
];

/** Mirrors ROLES on the server; used only to hide actions the server would refuse. */
const RANK: Role[] = ['viewer', 'operator', 'admin', 'owner'];
const rank = (role: Role | null) => (role ? RANK.indexOf(role) : -1);

async function copyText(text: string, message: string, fallback: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(message);
  } catch {
    // Clipboard needs a secure context — the link stays on screen to copy by hand
    toast.message(fallback, { duration: 10_000 });
  }
}

/** A link shown once, with a copy button, until dismissed. */
function OneTimeLink({
  title,
  body,
  link,
  onDismiss,
}: {
  title: string;
  body: string;
  link: string;
  onDismiss: () => void;
}) {
  return (
    <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
      <div className="flex items-start gap-2">
        <TriangleAlert size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">{title}</p>
          <p className="text-xs text-muted-foreground mb-2">{body}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded bg-background px-2 py-1.5 text-xs font-mono">
              {link}
            </code>
            <button
              onClick={() => copyText(link, 'Link copied', 'Copy the link below')}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs hover:bg-muted"
            >
              <Copy size={12} /> Copy
            </button>
          </div>
        </div>
        <button onClick={onDismiss} className="text-muted-foreground hover:text-foreground">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: OrgMember['status'] }) {
  return (
    <span
      className={cn(
        'rounded px-2 py-0.5 text-xs font-medium',
        status === 'active'
          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'bg-red-500/10 text-red-600 dark:text-red-400',
      )}
    >
      {status === 'active' ? 'Active' : 'Suspended'}
    </span>
  );
}

function accessSummary(m: OrgMember): string {
  if (rank(m.role) >= rank('admin') || m.serverAccess === 'all') return 'All servers';
  if (m.serverCount === 0) return 'No servers';
  return `${m.serverCount} server${m.serverCount === 1 ? '' : 's'}`;
}

/** Pick which servers a restricted member may use. */
function ServerAccessDialog({ member, onClose }: { member: OrgMember; onClose: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<MemberServerAccess['serverAccess'] | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);

  const { data: servers } = useQuery<Server[]>({ queryKey: ['servers'], queryFn: () => api.get('/servers') });
  const { data: access, isLoading } = useQuery<MemberServerAccess>({
    queryKey: ['member-access', member.userId],
    queryFn: () => api.get(`/team/members/${member.userId}/access`),
  });

  // Local edits win; until the first edit, show what the server has
  const effectiveMode = mode ?? access?.serverAccess ?? 'all';
  const effectiveSelected = selected ?? new Set(access?.serverIds ?? []);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.put<MemberServerAccess>(`/team/members/${member.userId}/access`, {
        serverAccess: effectiveMode,
        serverIds: [...effectiveSelected],
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-members'] });
      qc.invalidateQueries({ queryKey: ['member-access', member.userId] });
      toast.success('Server access updated');
      onClose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function toggle(id: string) {
    const next = new Set(effectiveSelected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <ServerCog size={16} className="text-primary shrink-0" />
          <span className="flex-1 truncate text-sm font-semibold">Server access — {member.displayName}</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  className="mt-1"
                  checked={effectiveMode === 'all'}
                  onChange={() => setMode('all')}
                />
                <span>
                  <span className="font-medium">All servers</span>
                  <span className="block text-xs text-muted-foreground">Including servers added later.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  className="mt-1"
                  checked={effectiveMode === 'restricted'}
                  onChange={() => setMode('restricted')}
                />
                <span>
                  <span className="font-medium">Only selected servers</span>
                  <span className="block text-xs text-muted-foreground">
                    Other servers are hidden everywhere — lists, terminals, files, commands, cron and monitoring.
                  </span>
                </span>
              </label>
              {effectiveMode === 'restricted' && (
                <div className="rounded-md border border-border divide-y divide-border">
                  {!servers?.length ? (
                    <p className="px-3 py-4 text-sm text-muted-foreground">No servers yet.</p>
                  ) : (
                    servers.map((srv) => (
                      <label key={srv.id} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50">
                        <input
                          type="checkbox"
                          checked={effectiveSelected.has(srv.id)}
                          onChange={() => toggle(srv.id)}
                        />
                        <span className="flex-1 truncate">{srv.name}</span>
                        <span className="text-xs text-muted-foreground font-mono truncate">{srv.host}</span>
                      </label>
                    ))
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
            Cancel
          </button>
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || isLoading}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saveMutation.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TeamMembers() {
  const qc = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const myRole = useAuthStore((s) => s.role);
  const isAdmin = useHasRole('admin');
  const [accessFor, setAccessFor] = useState<OrgMember | null>(null);
  // Like invite links, a reset link is shown once and never again
  const [resetLink, setResetLink] = useState<(PasswordResetLink & { email: string }) | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  // The accept URL is returned once and never again — hold it until dismissed.
  const [createdInvite, setCreatedInvite] = useState<CreatedInvite | null>(null);

  const { data: members } = useQuery<OrgMember[]>({
    queryKey: ['team-members'],
    queryFn: () => api.get('/team/members'),
  });

  const { data: invites } = useQuery<Invite[]>({
    queryKey: ['team-invites'],
    queryFn: () => api.get('/team/invites'),
    enabled: isAdmin,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['team-members'] });
    qc.invalidateQueries({ queryKey: ['team-invites'] });
  };

  const inviteMutation = useMutation({
    mutationFn: (body: { email: string; role: Role }) =>
      api.post<CreatedInvite>('/team/invites', body),
    onSuccess: async (invite) => {
      refresh();
      setShowInvite(false);
      setEmail('');
      setCreatedInvite(invite);
      await copyLink(invite.link, 'Invite created — link copied to clipboard');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/team/invites/${id}`),
    onSuccess: () => { refresh(); toast.success('Invite revoked'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api.patch(`/team/members/${userId}`, { role }),
    onSuccess: () => { refresh(); toast.success('Role updated'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => api.delete(`/team/members/${userId}`),
    onSuccess: () => { refresh(); toast.success('Member removed'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const statusMutation = useMutation({
    mutationFn: ({ userId, suspend }: { userId: string; suspend: boolean }) =>
      api.post(`/team/members/${userId}/${suspend ? 'suspend' : 'reactivate'}`),
    onSuccess: (_res, { suspend }) => {
      refresh();
      toast.success(suspend ? 'Member suspended and signed out' : 'Member reactivated');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resetMutation = useMutation({
    // Taking over an account: the server may first want this session to confirm a passkey
    mutationFn: (member: OrgMember) =>
      withStepUp(() => api.post<PasswordResetLink>(`/team/members/${member.userId}/password-reset`)),
    onSuccess: async (res, member) => {
      setResetLink({ ...res, email: member.email });
      await copyText(res.link, 'Reset link created — copied to clipboard', 'Copy the reset link below');
    },
    onError: (err: Error) => { if (!isPasskeyCancel(err)) toast.error(passkeyErrorMessage(err)); },
  });

  const passkeyResetMutation = useMutation({
    mutationFn: (userId: string) =>
      withStepUp(() => api.delete<{ removed: number; revoked: number }>(`/team/members/${userId}/passkeys`)),
    onSuccess: (res) => {
      refresh();
      qc.invalidateQueries({ queryKey: ['team-settings'] });
      toast.success(`Removed ${res.removed} passkey${res.removed === 1 ? '' : 's'} and signed them out`);
    },
    onError: (err: Error) => { if (!isPasskeyCancel(err)) toast.error(passkeyErrorMessage(err)); },
  });

  const signOutMutation = useMutation({
    mutationFn: (userId: string) => api.delete<{ revoked: number }>(`/team/members/${userId}/sessions`),
    onSuccess: (res) => {
      refresh();
      toast.success(`Signed out of ${res.revoked} session${res.revoked === 1 ? '' : 's'}`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function copyLink(link: string, message = 'Invite link copied') {
    return copyText(link, message, 'Copy the invite link below');
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold">Members</h2>
        {isAdmin && (
          <button
            onClick={() => setShowInvite((v) => !v)}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <UserPlus size={14} /> Invite person
          </button>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        People with access to this organization, and what they are allowed to do.
      </p>

      {createdInvite && (
        <OneTimeLink
          title="Copy this link now — it won't be shown again"
          body={
            createdInvite.existingAccount
              ? `Send it to ${createdInvite.email}. They already have an account, so they accept by signing in as it. If you lose the link, revoke the invite and create a new one.`
              : `Send it to ${createdInvite.email}. They must confirm that address to accept, so it is useless to anyone else. If you lose it, revoke the invite and create a new one.`
          }
          link={createdInvite.link}
          onDismiss={() => setCreatedInvite(null)}
        />
      )}

      {resetLink && (
        <OneTimeLink
          title="Copy this password reset link now — it won't be shown again"
          body={`Send it to ${resetLink.email} privately. It works once, expires ${new Date(resetLink.expiresAt).toLocaleString()}, and signs them out everywhere when used. Issuing another link cancels this one.`}
          link={resetLink.link}
          onDismiss={() => setResetLink(null)}
        />
      )}

      {showInvite && (
        <div className="mb-4 rounded-lg border border-border bg-card p-5">
          <h3 className="text-sm font-semibold mb-3">Invite someone</h3>
          <form
            onSubmit={(e) => { e.preventDefault(); inviteMutation.mutate({ email, role }); }}
            className="space-y-3"
          >
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="teammate@example.com"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Role</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label} — {r.hint}</option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              No mail server is configured, so you get a link to share. It is shown once, expires in 7 days,
              and can only be redeemed by someone who knows the invited email address.
            </p>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={inviteMutation.isPending}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {inviteMutation.isPending ? 'Creating…' : 'Create invite'}
              </button>
              <button type="button" onClick={() => setShowInvite(false)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        {!members?.length ? (
          <div className="flex flex-col items-center py-12 text-muted-foreground">
            <Users size={36} className="mb-3 opacity-30" />
            <p className="text-sm">No members.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Member</th>
                <th className="px-4 py-2 font-medium">Role</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Servers</th>
                {isAdmin && <th className="px-4 py-2 font-medium">Passkeys</th>}
                <th className="px-4 py-2 font-medium">Last active</th>
                {isAdmin && <th className="px-4 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {members.map((m) => {
                const isSelf = m.userId === currentUser?.id;
                // The server refuses actions on anyone ranked above you; don't offer them
                const manageable = isAdmin && !isSelf && rank(m.role) <= rank(myRole);
                const privileged = rank(m.role) >= rank('admin');
                // Role changes, removal, suspend / reactivate and sign out need a higher
                // rank, except owner on owner; a password or passkey reset always needs
                // a strictly higher rank.
                const canLockOut = rank(m.role) < rank(myRole) || (myRole === 'owner' && m.role === 'owner');
                const canReset = rank(m.role) < rank(myRole);
                return (
                  <tr key={m.userId} className={cn(m.status === 'suspended' && 'opacity-70')}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="size-8 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                          {m.displayName?.[0]?.toUpperCase() ?? m.email[0]?.toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium truncate">
                            {m.displayName}
                            {isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">{m.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {manageable && canLockOut ? (
                        <select
                          value={m.role}
                          onChange={(e) => roleMutation.mutate({ userId: m.userId, role: e.target.value as Role })}
                          className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
                        >
                          {ROLE_OPTIONS.filter((r) => rank(r.value) <= rank(myRole)).map((r) => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="rounded bg-muted px-2 py-1 text-xs capitalize text-muted-foreground">{m.role}</span>
                      )}
                    </td>
                    <td className="px-4 py-3"><StatusPill status={m.status} /></td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{accessSummary(m)}</td>
                    {isAdmin && (
                      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                        {m.passkeyCount || '—'}
                      </td>
                    )}
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {m.lastActiveAt ? relativeTime(m.lastActiveAt) : '—'}
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-3">
                        {manageable && (
                          <div className="flex items-center justify-end gap-2">
                            {!canLockOut ? null : m.status === 'active' ? (
                              <button
                                onClick={() => {
                                  if (confirm(`Suspend ${m.email}? They are signed out and cannot use this organization until reactivated.`))
                                    statusMutation.mutate({ userId: m.userId, suspend: true });
                                }}
                                className="text-muted-foreground hover:text-foreground"
                                title="Suspend"
                              >
                                <UserX size={14} />
                              </button>
                            ) : (
                              <button
                                onClick={() => statusMutation.mutate({ userId: m.userId, suspend: false })}
                                className="text-muted-foreground hover:text-foreground"
                                title="Reactivate"
                              >
                                <UserCheck size={14} />
                              </button>
                            )}
                            <button
                              onClick={() => setAccessFor(m)}
                              disabled={privileged}
                              className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
                              title={privileged ? 'Owners and admins always have access to every server' : 'Manage server access'}
                            >
                              <ServerCog size={14} />
                            </button>
                            {canReset && (
                              <button
                                onClick={() => {
                                  if (confirm(`Create a one-time password reset link for ${m.email}?`)) resetMutation.mutate(m);
                                }}
                                className="text-muted-foreground hover:text-foreground"
                                title="Issue password reset link"
                              >
                                <KeyRound size={14} />
                              </button>
                            )}
                            {canReset && (m.passkeyCount ?? 0) > 0 && (
                              <button
                                onClick={() => {
                                  if (confirm(`Remove all of ${m.email}'s passkeys and sign them out? They sign in with their password and create a new one.`))
                                    passkeyResetMutation.mutate(m.userId);
                                }}
                                className="text-muted-foreground hover:text-foreground"
                                title="Reset passkeys"
                              >
                                <Fingerprint size={14} />
                              </button>
                            )}
                            {canLockOut && (
                              <button
                                onClick={() => {
                                  if (confirm(`Sign ${m.email} out of every browser?`)) signOutMutation.mutate(m.userId);
                                }}
                                className="text-muted-foreground hover:text-foreground"
                                title="Sign out everywhere"
                              >
                                <LogOut size={14} />
                              </button>
                            )}
                            {canLockOut && (
                              <button
                                onClick={() => { if (confirm(`Remove ${m.email} from this organization?`)) removeMutation.mutate(m.userId); }}
                                className="text-red-500 hover:text-red-600"
                                title="Remove from organization"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {accessFor && <ServerAccessDialog member={accessFor} onClose={() => setAccessFor(null)} />}

      {isAdmin && invites && invites.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5 text-muted-foreground">
            <Clock size={13} /> Pending invites
          </h3>
          <div className="rounded-lg border border-border bg-card divide-y divide-border">
            {invites.map((invite) => (
              <div key={invite.id} className="flex items-center gap-3 px-4 py-3">
                <Plus size={15} className="text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{invite.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {invite.role}
                    {invite.state === 'expired'
                      ? ' · expired'
                      : ` · expires ${new Date(invite.expiresAt).toLocaleDateString()}`}
                  </p>
                </div>
                <button
                  onClick={() => revokeMutation.mutate(invite.id)}
                  className="text-red-500 hover:text-red-600"
                  title="Revoke invite"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
