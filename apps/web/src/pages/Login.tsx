import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, WebAuthnAbortService } from '@simplewebauthn/browser';
import { useAuthStore } from '@/store/auth.js';
import { api, ApiError } from '@/lib/api.js';
import {
  finishPasswordLogin,
  finishWithBackupCode,
  insecureContext,
  isPasskeyCancel,
  isSignInExpired,
  passkeyErrorMessage,
  passwordlessLogin,
} from '@/lib/passkeys.js';
import type { LoginResponse, Me, PasskeyLoginStep, SignedIn, SsoErrorCode, SsoLookupResult, User } from '@smt/shared';
import { Building2, Fingerprint, KeyRound } from 'lucide-react';
import { toast } from 'sonner';

/** What each /login?sso_error=… means. Fixed text: nothing from the URL is shown. */
const SSO_ERRORS: Record<SsoErrorCode, string> = {
  expired: 'The single sign-on attempt expired or was already used. Try again.',
  state: 'The single sign-on attempt did not start in this browser. Try again from here.',
  denied: 'Your identity provider did not sign you in.',
  unavailable: 'Single sign-on is not available for that organization right now.',
  token: 'Your identity provider’s answer could not be verified. Ask your administrator to check the SSO setup.',
  email_unverified: 'Your identity provider did not confirm your email address.',
  domain: 'Your email domain is not allowed to sign in to this organization.',
  not_member: 'You are not a member of this organization. Ask an admin to invite you.',
  account_exists:
    'An account with your email already exists but is not in this organization. Ask an admin of the organization to invite it.',
  identity_conflict: 'Your account is already linked to a different identity at this provider. Ask an admin for help.',
  suspended: 'Your access to this organization is suspended. Contact an organization admin.',
};

export default function LoginPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const setUser = useAuthStore((s) => s.setUser);
  const setPasskeyGate = useAuthStore((s) => s.setPasskeyGate);
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  const ssoRequired = useAuthStore((s) => s.ssoRequired);
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
  // "Sign in with SSO": an org slug or work email, then which org and IdP it leads to
  const [ssoMode, setSsoMode] = useState(!!ssoRequired);
  const [ssoQuery, setSsoQuery] = useState(ssoRequired?.orgSlug ?? '');
  const [ssoTarget, setSsoTarget] = useState<SsoLookupResult | null>(null);
  const ssoError = params.get('sso_error') as SsoErrorCode | null;
  const returningFromSso = params.get('sso') === 'done';

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

  // Back from the identity provider with a session cookie: load who it is for
  useEffect(() => {
    if (!returningFromSso) return;
    api
      .get<Me>('/auth/me')
      .then((me) => {
        setUser({ id: me.id, email: me.email, displayName: me.displayName } as User, me.orgId, me.role);
        // SSO counts as a passkey sign-in only when the IdP reported phishing-resistant MFA
        if (me.requirePasskey && !me.passkeyVerified) {
          setPasskeyGate(true);
          navigate('/passkey-setup', { replace: true });
        } else {
          navigate('/', { replace: true });
        }
      })
      .catch((err: unknown) => {
        setParams({}, { replace: true });
        toast.error(err instanceof Error ? err.message : 'Single sign-on failed');
      });
    // Once per return from the identity provider
  }, [returningFromSso]);

  // Offer saved passkeys in the email field's autofill list, where supported
  useEffect(() => {
    if (!passkeysAvailable || returningFromSso) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (err instanceof ApiError && err.code === 'SSO_REQUIRED') {
        // Right password, but this org only takes single sign-on from them
        setPassword('');
        openSso(String(err.details?.orgSlug ?? ''));
      }
      toast.error(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  function openSso(query = '') {
    WebAuthnAbortService.cancelCeremony();
    setSsoMode(true);
    setSsoTarget(null);
    if (query) setSsoQuery(query);
  }

  async function lookupSso(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      setSsoTarget(await api.post<SsoLookupResult>('/auth/sso/lookup', { query: ssoQuery }));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not find single sign-on for that');
    } finally {
      setLoading(false);
    }
  }

  function continueToSso() {
    if (!ssoTarget) return;
    setLoading(true);
    // A full-page navigation: the server redirects on to the identity provider
    window.location.assign(ssoTarget.startUrl);
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
        {ssoRequired && (
          <div
            role="status"
            className="mb-6 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400"
          >
            {ssoRequired.message}
          </div>
        )}
        {ssoError && (
          <div
            role="alert"
            className="mb-6 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
          >
            {/* Own keys only: ?sso_error=__proto__ must not index into Object.prototype */}
            {Object.prototype.hasOwnProperty.call(SSO_ERRORS, ssoError)
              ? SSO_ERRORS[ssoError]
              : 'Single sign-on failed. Try again.'}
          </div>
        )}
        {returningFromSso ? (
          <p className="text-sm text-muted-foreground">Finishing single sign-on…</p>
        ) : ssoMode ? (
          ssoTarget ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-md border border-border bg-muted/40 px-3 py-3 text-sm">
                <Building2 size={18} className="mt-0.5 shrink-0 text-primary" />
                <p>
                  Sign in to <span className="font-medium">{ssoTarget.orgName}</span> through{' '}
                  <span className="font-mono text-xs">{ssoTarget.providerHost}</span>.
                </p>
              </div>
              <button
                type="button"
                onClick={continueToSso}
                disabled={loading}
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {loading ? 'Redirecting…' : 'Continue'}
              </button>
              <button
                type="button"
                onClick={() => setSsoTarget(null)}
                disabled={loading}
                className="w-full rounded-md border border-border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
              >
                Back
              </button>
            </div>
          ) : (
            <form onSubmit={lookupSso} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1" htmlFor="sso-query">Organization or work email</label>
                <input
                  id="sso-query"
                  type="text"
                  autoFocus
                  required
                  autoComplete="email"
                  spellCheck={false}
                  placeholder="acme or you@acme.com"
                  value={ssoQuery}
                  onChange={(e) => setSsoQuery(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <button
                type="submit"
                disabled={loading || !ssoQuery.trim()}
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {loading ? 'Looking up…' : 'Continue with SSO'}
              </button>
              <button
                type="button"
                onClick={() => setSsoMode(false)}
                className="w-full rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
              >
                Sign in with a password or passkey
              </button>
            </form>
          )
        ) : pending && usingCode ? (
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
            <button
              type="button"
              onClick={() => openSso(email.includes('@') ? email : '')}
              disabled={loading}
              className="mt-2 w-full flex items-center justify-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50 transition-colors"
            >
              <Building2 size={15} /> Sign in with SSO
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
