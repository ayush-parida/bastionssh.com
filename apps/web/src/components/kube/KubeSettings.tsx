import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { KubeSettings as Settings } from '@smt/shared';
import { BellRing, FileText, Scaling, ShipWheel, TerminalSquare, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { kubeKeys } from '@/lib/kube.js';
import { useModule } from '@/hooks/useModules.js';
import { Switch } from '@/components/docker/DockerSettings.js';

const ROWS: { key: keyof Settings; title: string; detail: string; icon: typeof ShipWheel }[] = [
  {
    key: 'operatorsCanScale',
    title: 'Operators can scale and restart workloads',
    detail: 'Scale, restart a rollout, and trigger or suspend CronJobs. Admins and owners always can.',
    icon: Scaling,
  },
  {
    key: 'operatorsCanDeletePods',
    title: 'Operators can delete (restart) pods',
    detail: 'A pod with an owner is recreated; a bare pod is gone for good.',
    icon: Trash2,
  },
  {
    key: 'operatorsCanExec',
    title: 'Operators can open a shell in pods',
    detail: 'Shells are recorded like terminals. Rollbacks and cordoning nodes stay with admins.',
    icon: TerminalSquare,
  },
  {
    key: 'showConfigMapValues',
    title: 'Show ConfigMap values',
    detail: 'Off shows ConfigMap keys only. Secret values are never shown, whatever this says.',
    icon: FileText,
  },
  {
    key: 'clusterAlerts',
    title: 'Alert on cluster problems',
    detail: 'Alerts through your notification channels when a cluster is unreachable, a node is not ready, a workload has no ready replicas, or pods crash-loop or stay pending. Off by default.',
    icon: BellRing,
  },
];

/** The org's Kubernetes permissions (spec §7, §13). Owners and admins change them; nobody else sees this section. */
export default function KubeSettings() {
  const qc = useQueryClient();
  const isAdmin = useModule('kubernetes', 'manage');
  const { data: settings } = useQuery<Settings>({
    queryKey: kubeKeys.settings,
    queryFn: () => api.get('/kube/settings'),
    enabled: isAdmin,
  });
  const mutation = useMutation({
    mutationFn: (patch: Partial<Settings>) => api.patch<Settings>('/kube/settings', patch),
    onSuccess: (res) => {
      qc.setQueryData(kubeKeys.settings, res);
      // Every cluster page shows what the caller may do, and details may show values or not
      qc.invalidateQueries({ queryKey: ['kube'] });
      toast.success('Kubernetes settings saved');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (!isAdmin || !settings) return null;

  return (
    <section className="mt-10">
      <h2 className="mb-1 text-lg font-semibold">Kubernetes</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        What members may do on the clusters they can access. View access shows maps, workloads and redacted details;
        logs and YAML need operate access. The cluster’s own credential still bounds everything.
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
