import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, WebAuthnAbortService } from '@simplewebauthn/browser';
import { useAuthStore } from '@/store/auth.js';
import { api } from '@/lib/api.js';
import {
  finishPasswordLogin,
  finishWithBackupCode,
  insecureContext,
  isPasskeyCancel,
  isSignInExpired,
  passkeyErrorMessage,
  passwordlessLogin,
} from '@/lib/passkeys.js';
import type { LoginResponse, PasskeyLoginStep, SignedIn, User } from '@smt/shared';
import { Fingerprint, KeyRound } from 'lucide-react';
import { toast } from 'sonner';

export default function LoginPage() {
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const setPasskeyGate = useAuthStore((s) => s.setPasskeyGate);
  const setRecoveryGate = useAuthStore((s) => s.setRecoveryGate);
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  // The password was accepted; a passkey finishes the sign-in
  const [pending, setPending] = useState<PasskeyLoginStep | null>(null);
  // Finishing that sign-in with a backup code instead of the passkey
  const [usingCode, setUsingCode] = useState(false);
  const [code, setCode] = useState('');
  // Set while switching to a backup code, so the aborted passkey prompt is not reported
  const switchingToCode = useRef(false);
  const passkeysAvailable = !insecureContext && browserSupportsWebAuthn();

  function signedIn(res: SignedIn, to = '/', state?: unknown) {
    WebAuthnAbortService.cancelCeremony();
    setUser(res.user as User, res.orgId, res.role);
    if (res.passkeyEnrollmentRequired) {
      setPasskeyGate(true);
      navigate('/passkey-setup');
    } else {
      navigate(to, { state });
    }
  }

  function backToPassword() {
    WebAuthnAbortService.cancelCeremony();
    setPending(null);
    setUsingCode(false);
    setCode('');
    setPassword('');
  }

  function switchToBackupCode() {
    switchingToCode.current = true;
    WebAuthnAbortService.cancelCeremony();
    setUsingCode(true);
  }

  async function completeWithCode(e: React.FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setLoading(true);
    try {
      const res = await finishWithBackupCode(pending.ticket, code);
      const left = res.backupCodesRemaining;
      toast.success(`Signed in with a backup code. ${left} ${left === 1 ? 'code' : 'codes'} left.`);
      if (left <= 2) {
        toast.warning(
          left === 0
            ? 'That was your last backup code. Generate a new set now.'
            : 'You are running out of backup codes. Generate a new set.',
          { duration: 10_000 },
        );
      }
      // The org may hold this session to adding a passkey and verifying with it
      setRecoveryGate(res.recoveryOnly);
      // Most likely a passkey was lost: land where a new one can be added
      signedIn(res, '/settings', { backupCodeSignIn: true });
    } catch (err: unknown) {
      if (isSignInExpired(err)) backToPassword();
      else setCode('');
      toast.error(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setLoading(false);
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
    switchingToCode.current = false;
    setLoading(true);
    try {
      signedIn(await finishPasswordLogin(step.ticket, step.options));
    } catch (err: unknown) {
      if (switchingToCode.current && isPasskeyCancel(err)) {
        // Cancelled on purpose; the ticket is still good for a backup code
        switchingToCode.current = false;
      } else if (isPasskeyCancel(err)) {
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
        {pending && usingCode ? (
          <form onSubmit={completeWithCode} className="space-y-4">
            <div className="flex items-start gap-3 rounded-md border border-border bg-muted/40 px-3 py-3 text-sm">
              <KeyRound size={18} className="mt-0.5 shrink-0 text-primary" />
              <p>Enter one of your backup codes to finish signing in as <span className="font-medium">{email}</span>. Each code works once.</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="backup-code">Backup code</label>
              <input
                id="backup-code"
                type="text"
                autoFocus
                required
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={64}
                placeholder="XXXXX-XXXXX"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm tracking-wider uppercase focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !code.trim()}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Checking…' : 'Sign in'}
            </button>
            <button
              type="button"
              onClick={() => { setUsingCode(false); setCode(''); }}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-md border border-border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
            >
              <Fingerprint size={15} /> Use my passkey instead
            </button>
          </form>
        ) : pending ? (
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
              onClick={backToPassword}
              className="w-full rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
            >
              Back
            </button>
            <button
              type="button"
              onClick={switchToBackupCode}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              Lost your passkey? Use a backup code instead
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
            Default credentials: <span className="font-mono">ayush.parida@fgshq.com</span> / <span className="font-mono">admin1234</span>
          </p>
        )}
      </div>
    </div>
  );
}
