import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { Server, Key, Terminal, Clock } from 'lucide-react';
import type { Server as ServerType, SSHKey, SavedCommand, CronJob } from '@smt/shared';

function StatCard({ label, value, icon: Icon, color }: { label: string; value: number; icon: React.ElementType; color: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center gap-3">
        <div className={`rounded-md p-2 ${color}`}>
          <Icon size={18} />
        </div>
        <div>
          <p className="text-2xl font-bold">{value}</p>
          <p className="text-sm text-muted-foreground">{label}</p>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { data: servers } = useQuery<ServerType[]>({ queryKey: ['servers'], queryFn: () => api.get('/servers') });
  const { data: keys } = useQuery<SSHKey[]>({ queryKey: ['ssh-keys'], queryFn: () => api.get('/keys') });
  const { data: commands } = useQuery<SavedCommand[]>({ queryKey: ['saved-commands'], queryFn: () => api.get('/commands') });
  const { data: cronJobs } = useQuery<CronJob[]>({ queryKey: ['cron-jobs'], queryFn: () => api.get('/cron-jobs') });

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-1">Dashboard</h1>
      <p className="text-muted-foreground mb-6">Overview of your infrastructure</p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Servers" value={servers?.length ?? 0} icon={Server} color="bg-blue-500/10 text-blue-500" />
        <StatCard label="SSH Keys" value={keys?.length ?? 0} icon={Key} color="bg-emerald-500/10 text-emerald-500" />
        <StatCard label="Saved Commands" value={commands?.length ?? 0} icon={Terminal} color="bg-purple-500/10 text-purple-500" />
        <StatCard label="Cron Jobs" value={cronJobs?.filter(j => j.enabled).length ?? 0} icon={Clock} color="bg-orange-500/10 text-orange-500" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent servers */}
        <div className="rounded-lg border border-border bg-card">
          <div className="p-4 border-b border-border">
            <h2 className="font-semibold">Recent Servers</h2>
          </div>
          <div className="divide-y divide-border">
            {servers?.slice(0, 5).map((s) => (
              <div key={s.id} className="flex items-center gap-3 p-4">
                <div className="size-2 rounded-full bg-emerald-500" />
                <div>
                  <p className="text-sm font-medium">{s.name}</p>
                  <p className="text-xs text-muted-foreground">{s.username}@{s.host}:{s.port}</p>
                </div>
              </div>
            )) ?? <p className="p-4 text-sm text-muted-foreground">No servers yet.</p>}
          </div>
        </div>

        {/* Active cron jobs */}
        <div className="rounded-lg border border-border bg-card">
          <div className="p-4 border-b border-border">
            <h2 className="font-semibold">Active Cron Jobs</h2>
          </div>
          <div className="divide-y divide-border">
            {cronJobs?.filter(j => j.enabled).slice(0, 5).map((j) => (
              <div key={j.id} className="flex items-center justify-between p-4">
                <div>
                  <p className="text-sm font-medium">{j.name}</p>
                  <p className="text-xs text-muted-foreground font-mono">{j.schedule}</p>
                </div>
                {j.nextRunAt && (
                  <p className="text-xs text-muted-foreground">
                    Next: {new Date(j.nextRunAt).toLocaleString()}
                  </p>
                )}
              </div>
            )) ?? <p className="p-4 text-sm text-muted-foreground">No active cron jobs.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
