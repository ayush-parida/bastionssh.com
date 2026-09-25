import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import type { Me, OrgSummary, Role, User } from '@smt/shared';
import { Fingerprint, LogOut, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import {
  insecureContext,
  isPasskeyCancel,
  isReauthRequired,
  passkeyErrorMessage,
  registerPasskey,
  stepUp,
} from '@/lib/passkeys.js';
import { useAuthStore } from '@/store/auth.js';

/**
 * Where a session lands when its org requires passkeys and it has not used
 * one: create a first passkey, or confirm an existing one. Everything else in
 * the app answers PASSKEY_REQUIRED until then.
 */
export default function PasskeySetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, setUser, clearUser, setPasskeyGate } = useAuthStore();
  const [busy, setBusy] = useState(false);
  // A first passkey needs the password again, so a stolen session alone cannot add one
  const [password, setPassword] = useState('');

  const { data: me, refetch } = useQuery<Me>({ queryKey: ['auth-me'], queryFn: () => api.get('/auth/me') });
  const { data: orgs } = useQuery<OrgSummary[]>({ queryKey: ['auth-orgs'], queryFn: () => api.get('/auth/orgs') });
  const otherOrgs = orgs?.filter((o) => !o.current && o.status === 'active') ?? [];
  const supported = !insecureContext && browserSupportsWebAuthn();

  function done() {
    setPasskeyGate(false);
    // Anything fetched while blocked is stale
    void queryClient.resetQueries();
    navigate('/', { replace: true });
  }

  // Nothing to do here: the session is verified, or this org does not ask
  useEffect(() => {
    if (me && (me.passkeyVerified || !me.requirePasskey)) done();
    // done() only navigates; re-run when the answer changes
  }, [me]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      const { data } = await refetch();
      if (data?.passkeyVerified || !data?.requirePasskey) done();
    } catch (err) {
      if (isReauthRequired(err)) {
        toast.message('Sign in again, then create your passkey within 15 minutes.');
        await signOut();
      } else if (!isPasskeyCancel(err)) {
        toast.error(passkeyErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function switchOrg(orgId: string) {
    try {
      const res = await api.post<{ user: User; orgId: string; role: Role }>('/auth/switch-org', { orgId });
      setUser({ ...(user as User), ...res.user }, res.orgId, res.role);
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not switch organization');
    }
  }

  async function signOut() {
    await api.post('/auth/logout').catch(() => {});
    clearUser();
    queryClient.clear();
    navigate('/login');
  }

  const enrolling = me ? me.passkeyCount === 0 : false;

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-md bg-card border border-border rounded-lg p-8 shadow-sm">
        <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-primary/10">
          <ShieldCheck size={20} className="text-primary" />
        </div>
        <h1 className="text-xl font-bold mb-1">{enrolling ? 'Create a passkey' : 'Verify with your passkey'}</h1>
        <p className="text-sm text-muted-foreground mb-6">
          {enrolling
            ? 'This organization requires passkeys. Create one now — it signs you in with your fingerprint, face or device PIN instead of a password, and cannot be phished.'
            : 'This organization requires signing in with a passkey. Confirm with one of your passkeys to continue.'}
        </p>

        {!me ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !supported ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
            {insecureContext
              ? 'Passkeys need this page to be served over HTTPS (or from localhost). Ask your administrator.'
              : 'This browser does not support passkeys. Try a current version of Chrome, Safari, Edge or Firefox.'}
          </div>
        ) : enrolling ? (
          <form
            onSubmit={(e) => { e.preventDefault(); void run(() => registerPasskey(undefined, password), 'Passkey created'); }}
            className="space-y-3"
          >
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="passkey-password">Confirm your password</label>
              <input
                id="passkey-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Fingerprint size={15} /> {busy ? 'Waiting for your device…' : 'Create passkey'}
            </button>
          </form>
        ) : (
          <button
            onClick={() => run(stepUp, 'Verified')}
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Fingerprint size={15} /> {busy ? 'Waiting for your passkey…' : 'Verify with passkey'}
          </button>
        )}

        {me && !enrolling && (
          <p className="mt-3 text-xs text-muted-foreground">
            Lost access to your passkey? An admin of this organization can reset it; you then create a new one after signing in with your password.
          </p>
        )}

        {otherOrgs.length > 0 && (
          <div className="mt-6 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground mb-2">Or continue in another organization:</p>
            <div className="flex flex-wrap gap-2">
              {otherOrgs.map((o) => (
                <button
                  key={o.orgId}
                  onClick={() => switchOrg(o.orgId)}
                  className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
                >
                  {o.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={signOut}
          className="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <LogOut size={12} /> Sign out
        </button>
      </div>
    </div>
  );
}
