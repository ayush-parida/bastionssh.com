import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { isPasskeyCancel, passkeyErrorMessage, withStepUp } from '@/lib/passkeys.js';
import { useAuthStore } from '@/store/auth.js';
import type { Me, Role, User } from '@smt/shared';
import { KeyRound, UserCog } from 'lucide-react';
import { toast } from 'sonner';

export default function AccountSettings() {
  const { user, orgId, role, setUser } = useAuthStore();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const { data: me } = useQuery<Me>({ queryKey: ['auth-me'], queryFn: () => api.get('/auth/me') });

  const profileMutation = useMutation({
    mutationFn: () => api.patch<User & { orgId: string; role: Role }>('/auth/me', { displayName }),
    onSuccess: (res) => {
      setUser({ ...(user as User), displayName: res.displayName }, orgId ?? '', role ?? 'viewer');
      toast.success('Profile updated');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const passwordMutation = useMutation({
    // With a passkey on the account, this session must have used it
    mutationFn: () => withStepUp(() => api.post('/auth/change-password', { currentPassword, newPassword })),
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success('Password changed — other sessions were signed out');
    },
    onError: (err: Error) => { if (!isPasskeyCancel(err)) toast.error(passkeyErrorMessage(err)); },
  });

  function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error('The new passwords do not match');
      return;
    }
    passwordMutation.mutate();
  }

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold mb-1">Account</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Your profile and sign-in credentials.
      </p>

      <div className="rounded-lg border border-border bg-card p-5 space-y-6">
        <form
          onSubmit={(e) => { e.preventDefault(); profileMutation.mutate(); }}
          className="space-y-3"
        >
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <UserCog size={14} /> Profile
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Display name</label>
              <input
                type="text"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input
                type="email"
                value={user?.email ?? ''}
                disabled
                className="w-full rounded-md border border-input bg-muted px-3 py-2 text-sm text-muted-foreground"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={profileMutation.isPending || displayName === user?.displayName}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Save profile
          </button>
        </form>

        <div className="border-t border-border pt-5">
          {me && !me.hasPassword ? (
            <p className="text-sm text-muted-foreground flex items-center gap-1.5">
              <KeyRound size={14} /> This account signs in with single sign-on and has no password.
            </p>
          ) : (
          <form onSubmit={submitPassword} className="space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              <KeyRound size={14} /> Change password
            </h3>
            <div>
              <label className="block text-sm font-medium mb-1">Current password</label>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">New password</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Confirm new password</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              At least 8 characters. Changing it signs out your other sessions.
            </p>
            <button
              type="submit"
              disabled={passwordMutation.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {passwordMutation.isPending ? 'Changing…' : 'Change password'}
            </button>
          </form>
          )}
        </div>
      </div>
    </section>
  );
}
