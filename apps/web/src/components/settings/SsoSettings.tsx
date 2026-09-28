import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { isPasskeyCancel, passkeyErrorMessage, withStepUp } from '@/lib/passkeys.js';
import { useHasRole } from '@/store/auth.js';
import type { SsoProviderInput, SsoProviderKind, SsoRole, SsoRoleMapping, SsoSettings, SsoTestResult } from '@smt/shared';
import { Building2, Copy, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

const KINDS: { value: SsoProviderKind; label: string; issuer: string; hint: string }[] = [
  { value: 'google', label: 'Google Workspace', issuer: 'https://accounts.google.com', hint: 'Always https://accounts.google.com' },
  {
    value: 'microsoft',
    label: 'Microsoft Entra ID',
    issuer: 'https://login.microsoftonline.com/<tenant-id>/v2.0',
    hint: 'Use your tenant ID, not "common" or "organizations"',
  },
  { value: 'okta', label: 'Okta', issuer: 'https://<your-org>.okta.com', hint: 'Or an authorization server, e.g. …/oauth2/default' },
  { value: 'generic', label: 'Other OpenID Connect', issuer: 'https://idp.example.com', hint: 'The issuer, as in /.well-known/openid-configuration' },
];

const ROLES: SsoRole[] = ['viewer', 'operator', 'admin'];

interface Form {
  kind: SsoProviderKind;
  issuer: string;
  clientId: string;
  clientSecret: string;
  domains: string;
  defaultRole: SsoRole;
  autoProvision: boolean;
  enforceSso: boolean;
  enabled: boolean;
  trustIdpMfa: boolean;
  groupsClaim: string;
  roleMappings: SsoRoleMapping[];
}

const emptyForm: Form = {
  kind: 'generic',
  issuer: '',
  clientId: '',
  clientSecret: '',
  domains: '',
  defaultRole: 'viewer',
  autoProvision: false,
  enforceSso: false,
  enabled: true,
  trustIdpMfa: false,
  groupsClaim: '',
  roleMappings: [],
};

const input =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success('Copied'),
    () => toast.error('Could not copy'),
  );
}

/** The org's OpenID Connect provider. Owners only: the server answers 403 to anyone else. */
export default function SsoSettingsPanel() {
  const isOwner = useHasRole('owner');
  if (!isOwner) return null;
  return <SsoSettingsForm />;
}

function SsoSettingsForm() {
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(emptyForm);
  const [test, setTest] = useState<SsoTestResult | null>(null);

  const { data: settings } = useQuery<SsoSettings>({ queryKey: ['sso-settings'], queryFn: () => api.get('/sso') });

  // Load the saved provider into the form (the secret is never sent back)
  useEffect(() => {
    if (!settings?.configured) return;
    setForm({
      kind: settings.kind,
      issuer: settings.issuer,
      clientId: settings.clientId,
      clientSecret: '',
      domains: settings.allowedDomains.join(', '),
      defaultRole: settings.defaultRole,
      autoProvision: settings.autoProvision,
      enforceSso: settings.enforceSso,
      enabled: settings.enabled,
      trustIdpMfa: settings.trustIdpMfa,
      groupsClaim: settings.groupsClaim ?? '',
      roleMappings: settings.roleMappings,
    });
  }, [settings]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: () => {
      const body: SsoProviderInput = {
        kind: form.kind,
        issuer: form.issuer.trim(),
        clientId: form.clientId.trim(),
        ...(form.clientSecret && { clientSecret: form.clientSecret }),
        allowedDomains: form.domains.split(/[\s,]+/).filter(Boolean),
        defaultRole: form.defaultRole,
        autoProvision: form.autoProvision,
        enforceSso: form.enforceSso,
        enabled: form.enabled,
        trustIdpMfa: form.trustIdpMfa,
        groupsClaim: form.groupsClaim.trim() || null,
        roleMappings: form.roleMappings.filter((m) => m.group.trim()),
      };
      // Owners with a passkey confirm with it, as for the passkey policy
      return withStepUp(() => api.put<SsoSettings>('/sso', body));
    },
    onSuccess: (res) => {
      qc.setQueryData(['sso-settings'], res);
      toast.success('Single sign-on saved');
    },
    onError: (err: Error) => {
      if (!isPasskeyCancel(err)) toast.error(passkeyErrorMessage(err));
    },
  });

  const remove = useMutation({
    mutationFn: () => withStepUp(() => api.delete('/sso')),
    onSuccess: () => {
      setForm(emptyForm);
      setTest(null);
      qc.invalidateQueries({ queryKey: ['sso-settings'] });
      toast.success('Single sign-on removed');
    },
    onError: (err: Error) => {
      if (!isPasskeyCancel(err)) toast.error(passkeyErrorMessage(err));
    },
  });

  const runTest = useMutation({
    mutationFn: () => api.post<SsoTestResult>('/sso/test', form.issuer.trim() ? { issuer: form.issuer.trim() } : {}),
    onSuccess: setTest,
    onError: (err: Error) => toast.error(err.message),
  });

  if (!settings) return null;
  const configured = settings.configured;
  const kind = KINDS.find((k) => k.value === form.kind) ?? KINDS[3]!;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const saved = settings!.configured ? settings! : null;
    const turningOnEnforcement = form.enforceSso && form.enabled && !(saved?.enforceSso && saved.enabled);
    if (
      turningOnEnforcement &&
      !confirm(
        'Members other than owners will only be able to sign in with SSO. Their password and passkey sign-ins, and any terminals or file sessions they have open without SSO, end now. Continue?',
      )
    ) {
      return;
    }
    save.mutate();
  }

  function setMapping(i: number, patch: Partial<SsoRoleMapping>) {
    set(
      'roleMappings',
      form.roleMappings.map((m, j) => (j === i ? { ...m, ...patch } : m)),
    );
  }

  const checkbox = (key: 'autoProvision' | 'enforceSso' | 'enabled' | 'trustIdpMfa', label: string, help: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={form[key]}
        onChange={(e) => set(key, e.target.checked)}
        className="mt-0.5 accent-primary"
      />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{help}</span>
      </span>
    </label>
  );

  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold mb-1">Single sign-on</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Let members sign in with your identity provider over OpenID Connect (Google Workspace, Microsoft Entra ID, Okta
        or any other OIDC provider). SAML is not supported.
      </p>
      <form onSubmit={submit} className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs space-y-1">
          <p className="text-muted-foreground">Register this redirect URI with your provider (a web application client):</p>
          <p className="flex items-center gap-2 font-mono break-all">
            {settings.redirectUri}
            <button type="button" onClick={() => copy(settings.redirectUri)} title="Copy" className="text-muted-foreground hover:text-foreground">
              <Copy size={12} />
            </button>
          </p>
          {configured && (
            <>
              <p className="text-muted-foreground pt-1">Members can also start sign-in directly at:</p>
              <p className="flex items-center gap-2 font-mono break-all">
                {settings.loginUrl}
                <button type="button" onClick={() => copy(settings.loginUrl)} title="Copy" className="text-muted-foreground hover:text-foreground">
                  <Copy size={12} />
                </button>
              </p>
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="sso-kind">Provider</label>
            <select
              id="sso-kind"
              value={form.kind}
              onChange={(e) => {
                const next = KINDS.find((k) => k.value === e.target.value)!;
                setForm((f) => ({
                  ...f,
                  kind: next.value,
                  // Fill in Google's fixed issuer; leave anything typed alone
                  issuer: next.value === 'google' && !f.issuer ? next.issuer : f.issuer,
                }));
              }}
              className={input}
            >
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="sso-issuer">Issuer URL</label>
            <input
              id="sso-issuer"
              type="url"
              required
              placeholder={kind.issuer}
              value={form.issuer}
              onChange={(e) => set('issuer', e.target.value)}
              className={input}
            />
            <p className="mt-1 text-xs text-muted-foreground">{kind.hint}</p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="sso-client-id">Client ID</label>
            <input
              id="sso-client-id"
              required
              autoComplete="off"
              value={form.clientId}
              onChange={(e) => set('clientId', e.target.value)}
              className={input}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="sso-client-secret">Client secret</label>
            <input
              id="sso-client-secret"
              type="password"
              required={!configured}
              autoComplete="new-password"
              placeholder={configured ? 'Leave blank to keep the saved secret' : ''}
              value={form.clientSecret}
              onChange={(e) => set('clientSecret', e.target.value)}
              className={input}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="sso-domains">Allowed email domains</label>
            <input
              id="sso-domains"
              required
              placeholder="example.com, example.org"
              value={form.domains}
              onChange={(e) => set('domains', e.target.value)}
              className={input}
            />
            <p className="mt-1 text-xs text-muted-foreground">Exact domains; subdomains must be listed too.</p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="sso-role">Role for new accounts</label>
            <select
              id="sso-role"
              value={form.defaultRole}
              onChange={(e) => set('defaultRole', e.target.value as SsoRole)}
              className={input}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-3">
          {checkbox('enabled', 'Enabled', 'Turning this off ends every session that signed in through SSO.')}
          {checkbox(
            'autoProvision',
            'Create accounts on first sign-in',
            'Anyone your provider signs in with a verified address in an allowed domain joins with the role above. Otherwise only existing members (matched by verified email) can use SSO.',
          )}
          {checkbox(
            'enforceSso',
            'Require single sign-on',
            'Members other than owners can no longer sign in here with a password or passkey. Owners keep them as a way in if the provider is down. API tokens keep working.',
          )}
          {checkbox(
            'trustIdpMfa',
            'Trust phishing-resistant MFA reported by the provider',
            'When the provider says the sign-in used a security key or passkey (amr "hwk"/"fido", or acr "phr"), count it as a passkey sign-in for "Require passkeys". Otherwise SSO sign-ins still need a passkey where that is required.',
          )}
        </div>

        <details className="rounded-md border border-border px-3 py-2" open={form.roleMappings.length > 0}>
          <summary className="cursor-pointer text-sm font-medium">Map provider groups to roles (optional)</summary>
          <div className="mt-3 space-y-2">
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="sso-groups-claim">Groups claim</label>
              <input
                id="sso-groups-claim"
                placeholder="groups"
                value={form.groupsClaim}
                onChange={(e) => set('groupsClaim', e.target.value)}
                className={input}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                The ID token claim listing the user's groups. At each sign-in the highest mapped role replaces the
                member's role; owners are never changed and no group can grant owner.
              </p>
            </div>
            {form.roleMappings.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  aria-label="Group"
                  placeholder="Group name or ID"
                  value={m.group}
                  onChange={(e) => setMapping(i, { group: e.target.value })}
                  className={input}
                />
                <select
                  aria-label="Role"
                  value={m.role}
                  onChange={(e) => setMapping(i, { role: e.target.value as SsoRole })}
                  className={`${input} w-36`}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => set('roleMappings', form.roleMappings.filter((_, j) => j !== i))}
                  className="text-red-500 hover:text-red-600"
                  title="Remove"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => set('roleMappings', [...form.roleMappings, { group: '', role: 'viewer' }])}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <Plus size={12} /> Add mapping
            </button>
          </div>
        </details>

        {test && (
          <div
            role="status"
            className={
              test.ok
                ? 'rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400'
                : 'rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400'
            }
          >
            {test.ok
              ? `Found ${test.issuer} with ${test.signingKeys} signing key${test.signingKeys === 1 ? '' : 's'}. The client ID and secret are only checked by a real sign-in.`
              : test.error}
          </div>
        )}

        {form.enforceSso && form.enabled && (
          <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert size={12} className="shrink-0" />
            Sign in with SSO yourself before enforcing it, to be sure it works.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={save.isPending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : configured ? 'Save' : 'Set up single sign-on'}
          </button>
          <button
            type="button"
            onClick={() => runTest.mutate()}
            disabled={runTest.isPending || (!form.issuer.trim() && !configured)}
            className="flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            <Building2 size={14} /> {runTest.isPending ? 'Testing…' : 'Test discovery'}
          </button>
          {configured && (
            <button
              type="button"
              onClick={() => {
                if (confirm('Remove single sign-on? Everyone signed in through it is signed out.')) remove.mutate();
              }}
              disabled={remove.isPending}
              className="ml-auto flex items-center gap-1.5 rounded-md border border-red-500/40 px-4 py-2 text-sm text-red-600 hover:bg-red-500/10 disabled:opacity-50"
            >
              <Trash2 size={14} /> Remove
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
