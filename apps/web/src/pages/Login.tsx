import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, WebAuthnAbortService } from '@simplewebauthn/browser';
import { useAuthStore } from '@/store/auth.js';
import { api } from '@/lib/api.js';
import {
  finishPasswordLogin,
  insecureContext,
  isPasskeyCancel,
  passkeyErrorMessage,
  passwordlessLogin,
} from '@/lib/passkeys.js';
import type { LoginResponse, PasskeyLoginStep, SignedIn, User } from '@smt/shared';
import { Fingerprint } from 'lucide-react';
import { toast } from 'sonner';

export default function LoginPage() {
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const setPasskeyGate = useAuthStore((s) => s.setPasskeyGate);
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  // The password was accepted; a passkey finishes the sign-in
  const [pending, setPending] = useState<PasskeyLoginStep | null>(null);
  const passkeysAvailable = !insecureContext && browserSupportsWebAuthn();

  function signedIn(res: SignedIn) {
    WebAuthnAbortService.cancelCeremony();
    setUser(res.user as User, res.orgId, res.role);
    if (res.passkeyEnrollmentRequired) {
      setPasskeyGate(true);
      navigate('/passkey-setup');
    } else {
      navigate('/');
    }
  }

  // Offer saved passkeys in the email field's autofill list, where supported
  useEffect(() => {
    if (!passkeysAvailable) return;
    let active = true;
    browserSupportsWebAuthnAutofill()
      .then((supported) => {
        if (!supported || !active) return;
        return passwordlessLogin(true).then((res) => active && signedIn(res));
      })
      .catch((err) => {
        // Starting any other ceremony aborts this one; only real failures are worth saying
        if (active && !isPasskeyCancel(err)) toast.error(passkeyErrorMessage(err, 'Passkey sign-in failed'));
      });
    return () => {
      active = false;
      WebAuthnAbortService.cancelCeremony();
    };
    // Once per visit to the page
  }, []);

  async function completeWithPasskey(step: PasskeyLoginStep) {
    setLoading(true);
    try {
      signedIn(await finishPasswordLogin(step.ticket, step.options));
    } catch (err: unknown) {
      if (isPasskeyCancel(err)) {
        // The ticket is still good until it is used; let them try again
        toast.message('Passkey prompt dismissed. Use your passkey to finish signing in.');
      } else {
        // The server spends the ticket on any answer, so start over from the password
        setPending(null);
        toast.error(passkeyErrorMessage(err, 'Passkey sign-in failed'));
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.post<LoginResponse>('/auth/login', { email, password });
      if ('step' in res) {
        setPending(res);
        setLoading(false);
        await completeWithPasskey(res);
        return;
      }
      signedIn(res);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  async function handlePasskey() {
    setLoading(true);
    try {
      signedIn(await passwordlessLogin());
    } catch (err: unknown) {
      if (!isPasskeyCancel(err)) toast.error(passkeyErrorMessage(err, 'Passkey sign-in failed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30">
      <div className="w-full max-w-sm bg-card border border-border rounded-lg p-8 shadow-sm">
        <h1 className="text-xl font-bold mb-1">Sign in</h1>
        <p className="text-sm text-muted-foreground mb-6">to Server Management Tool</p>
        {sessionExpired && (
          <div
            role="status"
            className="mb-6 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400"
          >
            Your session expired. Please sign in again.
          </div>
        )}
        {pending ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-md border border-border bg-muted/40 px-3 py-3 text-sm">
              <Fingerprint size={18} className="mt-0.5 shrink-0 text-primary" />
              <p>Your account uses a passkey. Confirm with it to finish signing in as <span className="font-medium">{email}</span>.</p>
            </div>
            <button
              type="button"
              onClick={() => completeWithPasskey(pending)}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              <Fingerprint size={15} /> {loading ? 'Waiting for passkey…' : 'Use passkey'}
            </button>
            <button
              type="button"
              onClick={() => { WebAuthnAbortService.cancelCeremony(); setPending(null); setPassword(''); }}
              className="w-full rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
            >
              Back
            </button>
          </div>
        ) : (
          <>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1" htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  // "webauthn" lets the browser list saved passkeys here
                  autoComplete="username webauthn"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" htmlFor="password">Password</label>
                <input
                  id="password"
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
                disabled={loading}
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
            <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
              <div className="h-px flex-1 bg-border" /> or <div className="h-px flex-1 bg-border" />
            </div>
            <button
              type="button"
              onClick={handlePasskey}
              disabled={loading || !passkeysAvailable}
              className="w-full flex items-center justify-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Fingerprint size={15} /> Sign in with a passkey
            </button>
          </>
        )}
        {insecureContext && (
          <p className="mt-4 text-xs text-muted-foreground">
            Passkeys are unavailable because this page is not served over HTTPS. They work on HTTPS or on localhost.
          </p>
        )}
        {import.meta.env.DEV && (
          <p className="mt-4 text-center text-xs text-muted-foreground">
            Default credentials: <span className="font-mono">admin@smt.local</span> / <span className="font-mono">admin1234</span>
          </p>
        )}
      </div>
    </div>
  );
}
