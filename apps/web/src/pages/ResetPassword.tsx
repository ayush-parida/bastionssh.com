import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { useAuthStore } from '@/store/auth.js';
import type { PasswordResetPreview } from '@smt/shared';
import { toast } from 'sonner';

export default function ResetPasswordPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const clearUser = useAuthStore((s) => s.clearUser);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const { data: reset, isLoading, error } = useQuery<PasswordResetPreview>({
    queryKey: ['password-reset', token],
    queryFn: () => api.get(`/password-reset/${token}`),
    retry: false,
  });

  const resetMutation = useMutation({
    mutationFn: () => api.post(`/password-reset/${token}`, { password }),
    onSuccess: () => {
      // Every session was just ended server-side, this browser's included
      clearUser();
      toast.success('Password set — sign in with your new password');
      navigate('/login');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast.error('The passwords do not match');
      return;
    }
    resetMutation.mutate();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm bg-card border border-border rounded-lg p-8 shadow-sm">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Checking link…</p>
        ) : error || !reset ? (
          <Unusable message="This password reset link is not valid." />
        ) : reset.state === 'expired' ? (
          <Unusable message="This link has expired. Ask an admin for a new one." />
        ) : reset.state === 'used' ? (
          <Unusable message="This link has already been used." />
        ) : (
          <>
            <h1 className="text-xl font-bold mb-1">Set a new password</h1>
            <p className="text-sm text-muted-foreground mb-6">
              For <span className="font-mono">{reset.emailHint}</span>. Setting it signs this account out everywhere.
            </p>
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1" htmlFor="password">New password</label>
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
              <div>
                <label className="block text-sm font-medium mb-1" htmlFor="confirmPassword">Confirm new password</label>
                <input
                  id="confirmPassword"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <button
                type="submit"
                disabled={resetMutation.isPending}
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {resetMutation.isPending ? 'Saving…' : 'Set password'}
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
      <h1 className="text-xl font-bold mb-1">Link unavailable</h1>
      <p className="text-sm text-muted-foreground mb-6">{message}</p>
      <Link to="/login" className="text-sm text-primary hover:underline">Go to sign in</Link>
    </>
  );
}
