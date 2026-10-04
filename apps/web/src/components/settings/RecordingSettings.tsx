import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { RecordingSettings as Settings } from '@smt/shared';
import { Film, Keyboard, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { isPasskeyCancel, passkeyErrorMessage, withStepUp } from '@/lib/passkeys.js';
import { useIsOwner } from '@/hooks/useModules.js';

function Switch({ on, disabled, onToggle }: { on: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      disabled={disabled}
      title={on ? 'Turn off' : 'Turn on'}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50',
        on ? 'bg-primary' : 'bg-muted-foreground/30',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 size-4 rounded-full bg-background shadow transition-transform',
          on ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

/** The org's session recording policy. Owners change it; everyone else sees it. */
export default function RecordingSettings() {
  const qc = useQueryClient();
  const isOwner = useIsOwner();
  const [retention, setRetention] = useState('');

  const { data: settings } = useQuery<Settings>({
    queryKey: ['recording-settings'],
    queryFn: () => api.get('/recordings/settings'),
  });

  useEffect(() => {
    if (settings) setRetention(String(settings.retentionDays));
  }, [settings]);

  const mutation = useMutation({
    mutationFn: (patch: Partial<Settings>) =>
      withStepUp(() => api.patch<Settings>('/recordings/settings', patch)),
    onSuccess: (res) => {
      qc.setQueryData(['recording-settings'], res);
      toast.success('Recording settings saved');
    },
    onError: (err: Error) => {
      if (!isPasskeyCancel(err)) toast.error(passkeyErrorMessage(err, err.message));
    },
  });

  if (!settings) return null;

  function toggleInput() {
    if (
      !settings!.recordInput &&
      !confirm(
        'Keystrokes will be recorded, including passwords typed at sudo, su or login prompts — the terminal cannot tell when input is hidden. Anyone who can view a recording can read them. Continue?',
      )
    ) {
      return;
    }
    mutation.mutate({ recordInput: !settings!.recordInput });
  }

  function saveRetention(e: React.FormEvent) {
    e.preventDefault();
    const days = Number(retention);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      toast.error('Retention must be between 1 and 3650 days');
      return;
    }
    mutation.mutate({ retentionDays: days });
  }

  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold mb-1">Session recording</h2>
      <p className="text-sm text-muted-foreground mb-4">
        What is recorded when members open a terminal or run commands. Changes apply to sessions opened afterwards.
      </p>
      <div className="rounded-lg border border-border bg-card divide-y divide-border">
        <div className="flex items-start gap-3 p-4">
          <Film size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Record sessions</p>
            <p className="text-xs text-muted-foreground">
              Terminal output, plus commands run by the AI assistant and saved commands, is kept for playback.
            </p>
          </div>
          {isOwner ? (
            <Switch on={settings.enabled} disabled={mutation.isPending} onToggle={() => mutation.mutate({ enabled: !settings.enabled })} />
          ) : (
            <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{settings.enabled ? 'On' : 'Off'}</span>
          )}
        </div>

        <div className="p-4">
          <div className="flex items-start gap-3">
            <Keyboard size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Record keystrokes</p>
              <p className="text-xs text-muted-foreground">Also capture what members type, as a separate input stream.</p>
            </div>
            {isOwner ? (
              <Switch
                on={settings.recordInput}
                disabled={mutation.isPending || !settings.enabled}
                onToggle={toggleInput}
              />
            ) : (
              <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{settings.recordInput ? 'On' : 'Off'}</span>
            )}
          </div>
          <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert size={12} className="mt-0.5 shrink-0" />
            Passwords typed into the terminal (sudo, su, database prompts) are captured too — there is no reliable way
            to tell when a prompt hides its input.
          </p>
        </div>

        <form onSubmit={saveRetention} className="flex items-center gap-3 p-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Keep recordings for</p>
            <p className="text-xs text-muted-foreground">Older recordings are deleted by a daily cleanup.</p>
          </div>
          {isOwner ? (
            <>
              <input
                type="number"
                min={1}
                max={3650}
                value={retention}
                onChange={(e) => setRetention(e.target.value)}
                className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <span className="text-sm text-muted-foreground">days</span>
              <button
                type="submit"
                disabled={mutation.isPending || retention === String(settings.retentionDays)}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Save
              </button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">{settings.retentionDays} days</span>
          )}
        </form>
      </div>
    </section>
  );
}
