import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { useAuthStore, useHasRole } from '@/store/auth.js';
import type { OrgMember, Invite, CreatedInvite, Role } from '@smt/shared';
import { Plus, Trash2, UserPlus, Users, Copy, Clock, X, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

const ROLE_OPTIONS: { value: Role; label: string; hint: string }[] = [
  { value: 'viewer', label: 'Viewer', hint: 'Read-only access' },
  { value: 'operator', label: 'Operator', hint: 'Run commands and manage cron jobs' },
  { value: 'admin', label: 'Admin', hint: 'Manage servers, keys and people' },
  { value: 'owner', label: 'Owner', hint: 'Full control of the organization' },
];

export default function TeamMembers() {
  const qc = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const isAdmin = useHasRole('admin');
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

  async function copyLink(link: string, message = 'Invite link copied') {
    try {
      await navigator.clipboard.writeText(link);
      toast.success(message);
    } catch {
      // Clipboard needs a secure context — the link stays on screen to copy by hand
      toast.message('Copy the invite link below', { duration: 10_000 });
    }
  }

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold">Team</h2>
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
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="flex items-start gap-2">
            <TriangleAlert size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                Copy this link now — it won't be shown again
              </p>
              <p className="text-xs text-muted-foreground mb-2">
                Send it to {createdInvite.email}. They must confirm that address to accept, so it is
                useless to anyone else. If you lose it, revoke the invite and create a new one.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate rounded bg-background px-2 py-1.5 text-xs font-mono">
                  {createdInvite.link}
                </code>
                <button
                  onClick={() => copyLink(createdInvite.link)}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs hover:bg-muted"
                >
                  <Copy size={12} /> Copy
                </button>
              </div>
            </div>
            <button onClick={() => setCreatedInvite(null)} className="text-muted-foreground hover:text-foreground">
              <X size={14} />
            </button>
          </div>
        </div>
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

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {!members?.length ? (
          <div className="flex flex-col items-center py-12 text-muted-foreground">
            <Users size={36} className="mb-3 opacity-30" />
            <p className="text-sm">No members.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {members.map((m) => {
              const isSelf = m.userId === currentUser?.id;
              return (
                <div key={m.userId} className="flex items-center gap-3 px-4 py-3">
                  <div className="size-8 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                    {m.displayName?.[0]?.toUpperCase() ?? m.email[0]?.toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {m.displayName}
                      {isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">{m.email}</p>
                  </div>
                  {isAdmin && !isSelf ? (
                    <select
                      value={m.role}
                      onChange={(e) => roleMutation.mutate({ userId: m.userId, role: e.target.value as Role })}
                      className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                  ) : (
                    <span className="rounded bg-muted px-2 py-1 text-xs capitalize text-muted-foreground">{m.role}</span>
                  )}
                  {isAdmin && !isSelf && (
                    <button
                      onClick={() => { if (confirm(`Remove ${m.email} from this organization?`)) removeMutation.mutate(m.userId); }}
                      className="text-red-500 hover:text-red-600"
                      title="Remove from organization"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

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
