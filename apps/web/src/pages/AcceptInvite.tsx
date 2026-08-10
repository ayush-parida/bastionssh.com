import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { useAuthStore } from '@/store/auth.js';
import type { InvitePreview, Role, User } from '@smt/shared';
import { toast } from 'sonner';

interface AcceptResponse {
  user: User;
  orgId: string;
  role: Role;
}

export default function AcceptInvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');

  const { data: invite, isLoading, error } = useQuery<InvitePreview>({
    queryKey: ['invite', token],
    queryFn: () => api.get(`/invites/${token}`),
    retry: false,
  });

  const acceptMutation = useMutation({
    mutationFn: () =>
      api.post<AcceptResponse>(`/invites/${token}/accept`, { email, displayName, password }),
    onSuccess: (res) => {
      // The server already set the session cookie, so go straight in.
      setUser(res.user, res.orgId, res.role);
      toast.success(`Welcome to ${invite?.organizationName ?? 'the team'}`);
      navigate('/');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm bg-card border border-border rounded-lg p-8 shadow-sm">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Checking invite…</p>
        ) : error || !invite ? (
          <Unusable message="This invite link is not valid." />
        ) : invite.state === 'expired' ? (
          <Unusable message="This invite has expired. Ask an admin to send a new one." />
        ) : invite.state === 'accepted' ? (
          <Unusable message="This invite has already been used." />
        ) : (
          <>
            <h1 className="text-xl font-bold mb-1">Join {invite.organizationName}</h1>
            <p className="text-sm text-muted-foreground mb-6">
              You were invited as <span className="font-medium capitalize">{invite.role}</span>. Confirm the
              address this invite was sent to: <span className="font-mono">{invite.emailHint}</span>
            </p>
            <form
              onSubmit={(e) => { e.preventDefault(); acceptMutation.mutate(); }}
              className="space-y-4"
            >
              <div>
                <label className="block text-sm font-medium mb-1" htmlFor="email">Email address</label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" htmlFor="displayName">Your name</label>
                <input
                  id="displayName"
                  type="text"
                  required
                  autoComplete="name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <p className="mt-1 text-xs text-muted-foreground">At least 8 characters.</p>
              </div>
              <button
                type="submit"
                disabled={acceptMutation.isPending}
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {acceptMutation.isPending ? 'Creating account…' : 'Accept invite'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function Unusable({ message }: { message: string }) {
  return (
    <>
      <h1 className="text-xl font-bold mb-1">Invite unavailable</h1>
      <p className="text-sm text-muted-foreground mb-6">{message}</p>
      <Link to="/login" className="text-sm text-primary hover:underline">Go to sign in</Link>
    </>
  );
}
