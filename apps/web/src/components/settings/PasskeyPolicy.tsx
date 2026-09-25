import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { isPasskeyCancel, passkeyErrorMessage, withStepUp } from '@/lib/passkeys.js';
import { useHasRole } from '@/store/auth.js';
import type { OrgSecuritySettings } from '@smt/shared';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

/** The org's "require passkeys" switch. Owners change it; everyone else sees whether it is on. */
export default function PasskeyPolicy() {
  const qc = useQueryClient();
  const isOwner = useHasRole('owner');

  const { data: settings } = useQuery<OrgSecuritySettings>({
    queryKey: ['team-settings'],
    queryFn: () => api.get('/team/settings'),
  });

  const mutation = useMutation({
    // Turning it on needs the owner's own session to have used a passkey
    mutationFn: (requirePasskey: boolean) =>
      withStepUp(() => api.patch<OrgSecuritySettings>('/team/settings', { requirePasskey })),
    onSuccess: (res) => {
      qc.setQueryData(['team-settings'], res);
      qc.invalidateQueries({ queryKey: ['auth-me'] });
      toast.success(res.requirePasskey ? 'Passkeys are now required' : 'Passkeys are no longer required');
    },
    onError: (err: Error) => {
      if (!isPasskeyCancel(err)) toast.error(passkeyErrorMessage(err));
    },
  });

  if (!settings) return null;
  // Only admins and owners are told how many have enrolled
  const missing = settings.membersWithoutPasskey ?? 0;

  function toggle() {
    const next = !settings!.requirePasskey;
    if (
      next &&
      missing > 0 &&
      !confirm(
        `${missing} member${missing === 1 ? ' has' : 's have'} no passkey. They will have to create one before they can do anything else here. Continue?`,
      )
    ) {
      return;
    }
    mutation.mutate(next);
  }

  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold mb-1">Sign-in security</h2>
      <p className="text-sm text-muted-foreground mb-4">
        How members must sign in before they can use this organization.
      </p>
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Require passkeys for this organization</p>
            <p className="text-xs text-muted-foreground">
              Members must sign in with a passkey (alone, or after their password). Anyone without one is asked
              to create it right after signing in. Only API tokens created after verifying with a passkey keep working.
            </p>
          </div>
          {isOwner ? (
            <button
              role="switch"
              aria-checked={settings.requirePasskey}
              onClick={toggle}
              disabled={mutation.isPending}
              title={settings.requirePasskey ? 'Turn off' : 'Turn on'}
              className={cn(
                'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50',
                settings.requirePasskey ? 'bg-primary' : 'bg-muted-foreground/30',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 size-4 rounded-full bg-background shadow transition-transform',
                  settings.requirePasskey ? 'translate-x-4' : 'translate-x-0.5',
                )}
              />
            </button>
          ) : (
            <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {settings.requirePasskey ? 'On' : 'Off'}
            </span>
          )}
        </div>
        {missing > 0 && (isOwner || settings.requirePasskey) && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert size={12} className="shrink-0" />
            {missing} active member{missing === 1 ? '' : 's'} {missing === 1 ? 'has' : 'have'} no passkey yet
            {settings.requirePasskey ? ' and will be asked to create one at their next sign-in.' : '.'}
          </p>
        )}
      </div>
    </section>
  );
}
