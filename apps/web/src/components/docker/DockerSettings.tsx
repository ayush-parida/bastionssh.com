import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DockerSettings as Settings } from '@smt/shared';
import { BellRing, Container, Eraser, TerminalSquare, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { dockerKeys } from '@/lib/docker.js';
import { useModule } from '@/hooks/useModules.js';

export function Switch({ on, disabled, onToggle }: { on: boolean; disabled?: boolean; onToggle: () => void }) {
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

const ROWS: { key: keyof Settings; title: string; detail: string; icon: typeof Container }[] = [
  {
    key: 'operatorsCanExec',
    title: 'Operators can open a shell in containers',
    detail: 'Admins and owners always can. Shells are recorded like terminals.',
    icon: TerminalSquare,
  },
  {
    key: 'operatorsCanRemove',
    title: 'Operators can remove containers and images',
    detail: 'Off by default: removal loses a container’s writable layer for good.',
    icon: Trash2,
  },
  {
    key: 'allowPrune',
    title: 'Allow pruning',
    detail: 'Admins may delete unused containers, images, volumes and networks in one go.',
    icon: Eraser,
  },
  {
    key: 'containerAlerts',
    title: 'Alert on unhealthy, crash-looping and failed containers',
    detail:
      'The health check also lists containers on servers where Docker was detected, and alerts through your notification channels. Off by default.',
    icon: BellRing,
  },
];

/** The org's Docker permissions. Owners and admins change them; nobody else sees this section. */
export default function DockerSettings() {
  const qc = useQueryClient();
  const isAdmin = useModule('containers', 'manage');
  const { data: settings } = useQuery<Settings>({
    queryKey: dockerKeys.settings,
    queryFn: () => api.get('/docker/settings'),
    enabled: isAdmin,
  });
  const mutation = useMutation({
    mutationFn: (patch: Partial<Settings>) => api.patch<Settings>('/docker/settings', patch),
    onSuccess: (res) => {
      qc.setQueryData(dockerKeys.settings, res);
      // Every server's Docker tab shows what the caller may do
      qc.invalidateQueries({ queryKey: ['docker'] });
      toast.success('Docker settings saved');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (!isAdmin || !settings) return null;

  return (
    <section className="mt-10">
      <h2 className="mb-1 text-lg font-semibold">Docker</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        What members may do with Docker on the servers they can access. Viewers can list containers; logs, stats and
        details need the operator role.
      </p>
      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        {ROWS.map(({ key, title, detail, icon: Icon }) => (
          <div key={key} className="flex items-start gap-3 p-4">
            <Icon size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{title}</p>
              <p className="text-xs text-muted-foreground">{detail}</p>
            </div>
            <Switch on={settings[key]} disabled={mutation.isPending} onToggle={() => mutation.mutate({ [key]: !settings[key] })} />
          </div>
        ))}
      </div>
    </section>
  );
}
