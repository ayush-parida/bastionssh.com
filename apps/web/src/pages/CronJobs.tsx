import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import type { CronJob, Server, SavedCommand, CreateCronJobRequest } from '@smt/shared';
import { Plus, Clock, Trash2, ToggleLeft, ToggleRight, ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';

interface FormState {
  name: string;
  serverId: string;
  schedule: string;
  timezone: string;
  savedCommandId: string;
  inlineCommand: string;
}

const empty: FormState = { name: '', serverId: '', schedule: '0 * * * *', timezone: 'UTC', savedCommandId: '', inlineCommand: '' };

export default function CronJobsPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(empty);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: cronJobs } = useQuery<CronJob[]>({ queryKey: ['cron-jobs'], queryFn: () => api.get('/cron-jobs') });
  const { data: servers } = useQuery<Server[]>({ queryKey: ['servers'], queryFn: () => api.get('/servers') });
  const { data: commands } = useQuery<SavedCommand[]>({ queryKey: ['saved-commands'], queryFn: () => api.get('/commands') });

  const { data: preview } = useQuery<{ nextRuns: string[] }>({
    queryKey: ['cron-preview', form.schedule, form.timezone],
    queryFn: () => api.get(`/cron-jobs/schedule/preview?expression=${encodeURIComponent(form.schedule)}&timezone=${encodeURIComponent(form.timezone)}`),
    enabled: form.schedule.split(' ').length >= 5,
    retry: false,
  });

  const createMutation = useMutation({
    mutationFn: (body: CreateCronJobRequest) => api.post<CronJob>('/cron-jobs', body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cron-jobs'] }); setShowForm(false); setForm(empty); toast.success('Cron job created'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/cron-jobs/${id}`, { enabled }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cron-jobs'] }); },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/cron-jobs/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cron-jobs'] }); toast.success('Deleted'); },
    onError: (err: Error) => toast.error(err.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body: CreateCronJobRequest = {
      name: form.name,
      serverId: form.serverId,
      schedule: form.schedule,
      timezone: form.timezone,
    };
    if (form.savedCommandId) body.savedCommandId = form.savedCommandId;
    if (form.inlineCommand) body.inlineCommand = form.inlineCommand;
    createMutation.mutate(body);
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Cron Jobs</h1>
          <p className="text-muted-foreground text-sm">Scheduled tasks managed by the app</p>
        </div>
        <button onClick={() => setShowForm(true)} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          <Plus size={15} /> New job
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-lg border border-border bg-card p-5">
          <h2 className="font-semibold mb-4">New cron job</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input type="text" required value={form.name} onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Server</label>
                <select required value={form.serverId} onChange={(e) => setForm(p => ({ ...p, serverId: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary">
                  <option value="">Select…</option>
                  {servers?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Cron schedule</label>
                <input type="text" required value={form.schedule} onChange={(e) => setForm(p => ({ ...p, schedule: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary" placeholder="0 * * * *" />
                {preview?.nextRuns?.[0] && <p className="text-xs text-muted-foreground mt-1">Next: {new Date(preview.nextRuns[0] as string).toLocaleString()}</p>}
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Timezone</label>
                <input type="text" value={form.timezone} onChange={(e) => setForm(p => ({ ...p, timezone: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" placeholder="UTC" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Saved command (optional)</label>
              <select value={form.savedCommandId} onChange={(e) => setForm(p => ({ ...p, savedCommandId: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary">
                <option value="">None — use inline command</option>
                {commands?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            {!form.savedCommandId && (
              <div>
                <label className="block text-sm font-medium mb-1">Inline command</label>
                <input type="text" value={form.inlineCommand} onChange={(e) => setForm(p => ({ ...p, inlineCommand: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary" placeholder="e.g. /usr/local/bin/backup.sh" />
              </div>
            )}
            <div className="flex gap-2">
              <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">Create</button>
              <button type="button" onClick={() => setShowForm(false)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">Cancel</button>
            </div>
          </form>
        </div>
      )}

      {cronJobs?.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-muted-foreground">
          <Clock size={40} className="mb-3 opacity-30" />
          <p>No cron jobs yet.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr>
                {['', 'Name', 'Schedule', 'Server', 'Next run', 'Status', ''].map((h, i) => (
                  <th key={i} className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {cronJobs?.map((j) => (
                <tr key={j.id} className="hover:bg-muted/30">
                  <td className="px-3 py-3">
                    <button onClick={() => setExpanded(expanded === j.id ? null : j.id)}>
                      {expanded === j.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </td>
                  <td className="px-4 py-3 font-medium">{j.name}</td>
                  <td className="px-4 py-3 font-mono text-xs">{j.schedule}</td>
                  <td className="px-4 py-3 text-muted-foreground">{servers?.find(s => s.id === j.serverId)?.name ?? j.serverId}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : '—'}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => toggleMutation.mutate({ id: j.id, enabled: !j.enabled })} title={j.enabled ? 'Disable' : 'Enable'}>
                      {j.enabled ? <ToggleRight size={18} className="text-emerald-500" /> : <ToggleLeft size={18} className="text-muted-foreground" />}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => { if (confirm('Delete?')) deleteMutation.mutate(j.id); }} className="text-red-500 hover:text-red-600"><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
