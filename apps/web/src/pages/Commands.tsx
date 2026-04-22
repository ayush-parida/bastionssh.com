import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import type { SavedCommand, Server, CreateSavedCommandRequest } from '@smt/shared';
import { Plus, Play, Trash2, Pencil, Terminal } from 'lucide-react';
import { toast } from 'sonner';

interface FormState {
  name: string;
  serverId: string;
  command: string;
  description: string;
}

const empty: FormState = { name: '', serverId: '', command: '', description: '' };

export default function CommandsPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(empty);
  const [runVars, setRunVars] = useState<Record<string, string>>({});
  const [runningId, setRunningId] = useState<string | null>(null);
  const [output, setOutput] = useState<{ stdout: string; stderr: string; exitCode: number } | null>(null);

  const { data: commands } = useQuery<SavedCommand[]>({ queryKey: ['saved-commands'], queryFn: () => api.get('/commands') });
  const { data: servers } = useQuery<Server[]>({ queryKey: ['servers'], queryFn: () => api.get('/servers') });

  const createMutation = useMutation({
    mutationFn: (body: CreateSavedCommandRequest) => api.post<SavedCommand>('/commands', body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['saved-commands'] }); setShowForm(false); setForm(empty); toast.success('Command saved'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/commands/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['saved-commands'] }); toast.success('Deleted'); },
    onError: (err: Error) => toast.error(err.message),
  });

  async function handleRun(cmd: SavedCommand) {
    setRunningId(cmd.id);
    setOutput(null);
    try {
      const res = await api.post<{ runId: string }>(`/commands/${cmd.id}/run`, { variables: runVars });
      toast.success(`Job enqueued: ${res.runId}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    } finally {
      setRunningId(null);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createMutation.mutate({ ...form, serverId: form.serverId });
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Saved Commands</h1>
          <p className="text-muted-foreground text-sm">Run commands on your servers</p>
        </div>
        <button onClick={() => { setShowForm(true); setEditId(null); setForm(empty); }} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          <Plus size={15} /> New command
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-lg border border-border bg-card p-5">
          <h2 className="font-semibold mb-4">New command</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input type="text" required value={form.name} onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Server</label>
                <select required value={form.serverId} onChange={(e) => setForm(p => ({ ...p, serverId: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary">
                  <option value="">Select server…</option>
                  {servers?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Command <span className="text-muted-foreground text-xs">(use {'{{variable}}'} for placeholders)</span></label>
              <textarea rows={3} required value={form.command} onChange={(e) => setForm(p => ({ ...p, command: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description (optional)</label>
              <input type="text" value={form.description} onChange={(e) => setForm(p => ({ ...p, description: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
            </div>
            <div className="flex gap-2">
              <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">Save</button>
              <button type="button" onClick={() => setShowForm(false)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">Cancel</button>
            </div>
          </form>
        </div>
      )}

      {commands?.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-muted-foreground">
          <Terminal size={40} className="mb-3 opacity-30" />
          <p>No saved commands yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {commands?.map((cmd) => (
            <div key={cmd.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-start gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-sm">{cmd.name}</span>
                  </div>
                  <pre className="text-xs font-mono text-muted-foreground bg-muted rounded px-2 py-1 overflow-x-auto">{cmd.command}</pre>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => handleRun(cmd)} disabled={runningId === cmd.id} className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-600 hover:bg-emerald-500/20 disabled:opacity-50">
                    <Play size={12} /> {runningId === cmd.id ? 'Running…' : 'Run'}
                  </button>
                  <button onClick={() => { if (confirm('Delete?')) deleteMutation.mutate(cmd.id); }} className="text-red-500 hover:text-red-600">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
