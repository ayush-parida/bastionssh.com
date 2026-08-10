import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import type {
  SavedCommand,
  Server,
  CreateSavedCommandRequest,
  UpdateSavedCommandRequest,
  CommandRun,
  RunCommandResponse,
} from '@smt/shared';
import { Plus, Play, Trash2, Pencil, Terminal, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface FormState {
  name: string;
  serverId: string;
  command: string;
  category: string;
}

const empty: FormState = { name: '', serverId: '', command: '', category: '' };

/** Placeholder names in a command body, in order of first use. */
function extractVariables(command: string): string[] {
  const found = new Set<string>();
  for (const match of command.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) found.add(match[1]!);
  return [...found];
}

const TERMINAL_STATUSES = ['success', 'failure'];

export default function CommandsPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(empty);
  const [runTarget, setRunTarget] = useState<SavedCommand | null>(null);
  const [runServerId, setRunServerId] = useState('');
  const [runVars, setRunVars] = useState<Record<string, string>>({});
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const { data: commands } = useQuery<SavedCommand[]>({
    queryKey: ['saved-commands'],
    queryFn: () => api.get('/commands'),
  });
  const { data: servers } = useQuery<Server[]>({ queryKey: ['servers'], queryFn: () => api.get('/servers') });

  // Poll while a run is in flight; stop as soon as it reaches a terminal state.
  const { data: run } = useQuery<CommandRun>({
    queryKey: ['command-run', activeRunId],
    queryFn: () => api.get(`/commands/runs/${activeRunId}`),
    enabled: activeRunId !== null,
    refetchInterval: (query) =>
      query.state.data && TERMINAL_STATUSES.includes(query.state.data.status) ? false : 1000,
  });

  const serverName = (id?: string | null) => servers?.find((s) => s.id === id)?.name ?? 'unknown server';

  const createMutation = useMutation({
    mutationFn: (body: CreateSavedCommandRequest) => api.post<SavedCommand>('/commands', body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['saved-commands'] }); closeForm(); toast.success('Command saved'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateSavedCommandRequest }) =>
      api.patch<SavedCommand>(`/commands/${id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['saved-commands'] }); closeForm(); toast.success('Command updated'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/commands/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['saved-commands'] }); toast.success('Deleted'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const runMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { variables: Record<string, string>; serverId?: string } }) =>
      api.post<RunCommandResponse>(`/commands/${id}/run`, body),
    onSuccess: (res) => { setActiveRunId(res.runId); setRunTarget(null); },
    onError: (err: Error) => toast.error(err.message),
  });

  function openEdit(cmd: SavedCommand) {
    setEditId(cmd.id);
    setForm({
      name: cmd.name,
      serverId: cmd.serverId ?? '',
      command: cmd.command,
      category: cmd.category ?? '',
    });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditId(null);
    setForm(empty);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      name: form.name,
      command: form.command,
      serverId: form.serverId || null,
      category: form.category || null,
    };
    if (editId) updateMutation.mutate({ id: editId, body });
    else createMutation.mutate({ ...body, serverId: form.serverId || undefined, category: form.category || undefined });
  }

  /** Open the run panel, seeded with the command's default server and variables. */
  function openRun(cmd: SavedCommand) {
    setRunTarget(cmd);
    setRunServerId(cmd.serverId ?? '');
    setActiveRunId(null);
    const names = extractVariables(cmd.command);
    setRunVars(Object.fromEntries(names.map((n) => [n, cmd.variables?.[n]?.defaultValue ?? ''])));
  }

  function submitRun() {
    if (!runTarget) return;
    if (!runServerId) { toast.error('Pick a server to run on'); return; }
    runMutation.mutate({ id: runTarget.id, body: { variables: runVars, serverId: runServerId } });
  }

  const runVarNames = useMemo(
    () => (runTarget ? extractVariables(runTarget.command) : []),
    [runTarget],
  );

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Saved Commands</h1>
          <p className="text-muted-foreground text-sm">Reusable commands you can run on any server</p>
        </div>
        <button onClick={() => { closeForm(); setShowForm(true); }} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          <Plus size={15} /> New command
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-lg border border-border bg-card p-5">
          <h2 className="font-semibold mb-4">{editId ? 'Edit command' : 'New command'}</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input type="text" required value={form.name} onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  Default server <span className="text-muted-foreground text-xs">(optional)</span>
                </label>
                <select value={form.serverId} onChange={(e) => setForm(p => ({ ...p, serverId: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary">
                  <option value="">Any server — choose at run time</option>
                  {servers?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Command <span className="text-muted-foreground text-xs">(use {'{{variable}}'} for placeholders)</span></label>
              <textarea rows={3} required value={form.command} onChange={(e) => setForm(p => ({ ...p, command: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary" />
              {extractVariables(form.command).length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Variables: {extractVariables(form.command).map((v) => <span key={v} className="font-mono mr-1">{`{{${v}}}`}</span>)}
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Category (optional)</label>
              <input type="text" value={form.category} onChange={(e) => setForm(p => ({ ...p, category: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
            </div>
            <div className="flex gap-2">
              <button type="submit" disabled={createMutation.isPending || updateMutation.isPending} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {editId ? 'Update' : 'Save'}
              </button>
              <button type="button" onClick={closeForm} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">Cancel</button>
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
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-sm">{cmd.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {cmd.serverId ? serverName(cmd.serverId) : 'any server'}
                    </span>
                    {cmd.category && <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{cmd.category}</span>}
                  </div>
                  <pre className="text-xs font-mono text-muted-foreground bg-muted rounded px-2 py-1 overflow-x-auto">{cmd.command}</pre>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => openRun(cmd)} className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-600 hover:bg-emerald-500/20">
                    <Play size={12} /> Run
                  </button>
                  <button onClick={() => openEdit(cmd)} className="text-muted-foreground hover:text-foreground" title="Edit">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => { if (confirm(`Delete ${cmd.name}?`)) deleteMutation.mutate(cmd.id); }} className="text-red-500 hover:text-red-600" title="Delete">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {/* Run panel — target, variables, then live output */}
              {runTarget?.id === cmd.id && (
                <div className="mt-4 rounded-md border border-border bg-muted/30 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold">Run {cmd.name}</h3>
                    <button onClick={() => setRunTarget(null)} className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium mb-1">Server</label>
                      <select value={runServerId} onChange={(e) => setRunServerId(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary">
                        <option value="">Select server…</option>
                        {servers?.map(s => <option key={s.id} value={s.id}>{s.name} ({s.host})</option>)}
                      </select>
                    </div>
                    {runVarNames.map((name) => (
                      <div key={name}>
                        <label className="block text-xs font-medium mb-1">
                          {cmd.variables?.[name]?.label ?? name} <span className="font-mono text-muted-foreground">{`{{${name}}}`}</span>
                        </label>
                        <input
                          type="text"
                          value={runVars[name] ?? ''}
                          onChange={(e) => setRunVars((p) => ({ ...p, [name]: e.target.value }))}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                      </div>
                    ))}
                    <button onClick={submitRun} disabled={runMutation.isPending} className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                      <Play size={13} /> {runMutation.isPending ? 'Starting…' : 'Execute'}
                    </button>
                  </div>
                </div>
              )}

              {activeRunId && run?.commandId === cmd.id && (
                <div className="mt-4 rounded-md border border-border bg-background p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-sm">
                      {!TERMINAL_STATUSES.includes(run.status) ? (
                        <><Loader2 size={13} className="animate-spin text-muted-foreground" /> <span className="text-muted-foreground">{run.status === 'pending' ? 'Queued…' : 'Running…'}</span></>
                      ) : (
                        <span className={run.status === 'success' ? 'text-emerald-500 font-medium' : 'text-red-500 font-medium'}>
                          {run.status === 'success' ? 'Success' : 'Failed'}
                          {run.exitCode != null && ` · exit ${run.exitCode}`}
                          {run.durationMs != null && ` · ${(run.durationMs / 1000).toFixed(1)}s`}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">on {serverName(run.serverId)}</span>
                    </div>
                    <button onClick={() => setActiveRunId(null)} className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
                  </div>
                  {run.stdout && (
                    <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs font-mono whitespace-pre-wrap">{run.stdout}</pre>
                  )}
                  {run.stderr && (
                    <pre className="mt-2 max-h-40 overflow-auto rounded bg-red-500/10 p-2 text-xs font-mono text-red-500 whitespace-pre-wrap">{run.stderr}</pre>
                  )}
                  {TERMINAL_STATUSES.includes(run.status) && !run.stdout && !run.stderr && (
                    <p className="text-xs text-muted-foreground">No output.</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
