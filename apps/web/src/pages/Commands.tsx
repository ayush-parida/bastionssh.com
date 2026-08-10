import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import type {
  SavedCommand,
  Server,
  CreateSavedCommandRequest,
  UpdateSavedCommandRequest,
  CommandRun,
  CommandRunTarget,
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
  const [runServerIds, setRunServerIds] = useState<string[]>([]);
  const [runVars, setRunVars] = useState<Record<string, string>>({});
  const [activeRuns, setActiveRuns] = useState<CommandRunTarget[]>([]);

  const { data: commands } = useQuery<SavedCommand[]>({
    queryKey: ['saved-commands'],
    queryFn: () => api.get('/commands'),
  });
  const { data: servers } = useQuery<Server[]>({ queryKey: ['servers'], queryFn: () => api.get('/servers') });

  // One poll covers the whole fan-out; it stops once every run is terminal.
  const runIds = activeRuns.map((r) => r.runId);
  const { data: runs } = useQuery<CommandRun[]>({
    queryKey: ['command-runs', runIds.join(',')],
    queryFn: () => api.get(`/commands/runs?ids=${runIds.join(',')}`),
    enabled: runIds.length > 0,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.length < runIds.length) return 1000;
      return data.every((r) => TERMINAL_STATUSES.includes(r.status)) ? false : 1000;
    },
  });

  const serverName = (id?: string | null) => servers?.find((s) => s.id === id)?.name ?? 'unknown server';

  const allTags = [...new Set((servers ?? []).flatMap((s) => s.tags ?? []))].sort();
  const runsById = new Map((runs ?? []).map((r) => [r.id, r]));
  const doneCount = (runs ?? []).filter((r) => TERMINAL_STATUSES.includes(r.status)).length;
  const failedCount = (runs ?? []).filter((r) => r.status === 'failure').length;
  // Results render under the command they belong to
  const runsByCommand = (runs ?? [])[0]?.commandId ?? null;

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
    mutationFn: ({ id, body }: { id: string; body: { variables: Record<string, string>; serverIds: string[] } }) =>
      api.post<RunCommandResponse>(`/commands/${id}/run`, body),
    onSuccess: (res) => { setActiveRuns(res.runs); setRunTarget(null); },
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
    setRunServerIds(cmd.serverId ? [cmd.serverId] : []);
    setActiveRuns([]);
    const names = extractVariables(cmd.command);
    setRunVars(Object.fromEntries(names.map((n) => [n, cmd.variables?.[n]?.defaultValue ?? ''])));
  }

  function toggleServer(id: string) {
    setRunServerIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  }

  /** Select every server carrying a tag, keeping anything already ticked. */
  function selectTag(tag: string) {
    const tagged = (servers ?? []).filter((s) => (s.tags ?? []).includes(tag)).map((s) => s.id);
    const allSelected = tagged.every((id) => runServerIds.includes(id));
    setRunServerIds((prev) =>
      allSelected ? prev.filter((id) => !tagged.includes(id)) : [...new Set([...prev, ...tagged])],
    );
  }

  function submitRun() {
    if (!runTarget) return;
    if (runServerIds.length === 0) { toast.error('Pick at least one server to run on'); return; }
    runMutation.mutate({ id: runTarget.id, body: { variables: runVars, serverIds: runServerIds } });
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
                      <div className="flex items-center justify-between mb-1">
                        <label className="block text-xs font-medium">
                          Servers {runServerIds.length > 0 && `(${runServerIds.length} selected)`}
                        </label>
                        {runServerIds.length > 0 && (
                          <button onClick={() => setRunServerIds([])} className="text-xs text-muted-foreground hover:text-foreground">
                            Clear
                          </button>
                        )}
                      </div>
                      {allTags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          <span className="text-xs text-muted-foreground mr-1 py-0.5">By tag:</span>
                          {allTags.map((tag) => (
                            <button
                              key={tag}
                              onClick={() => selectTag(tag)}
                              className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted/70"
                            >
                              {tag}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="max-h-40 overflow-y-auto rounded-md border border-input bg-background divide-y divide-border">
                        {servers?.map((s) => (
                          <label key={s.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50">
                            <input
                              type="checkbox"
                              checked={runServerIds.includes(s.id)}
                              onChange={() => toggleServer(s.id)}
                              className="size-4 rounded border-input"
                            />
                            <span className="flex-1 truncate">{s.name}</span>
                            <span className="font-mono text-xs text-muted-foreground truncate">{s.host}</span>
                            {(s.tags ?? []).map((tag) => (
                              <span key={tag} className="rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground">{tag}</span>
                            ))}
                          </label>
                        ))}
                      </div>
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
                      <Play size={13} />
                      {runMutation.isPending
                        ? 'Starting…'
                        : runServerIds.length > 1
                          ? `Execute on ${runServerIds.length} servers`
                          : 'Execute'}
                    </button>
                  </div>
                </div>
              )}

              {activeRuns.length > 0 && activeRuns[0] && runsByCommand === cmd.id && (
                <div className="mt-4 rounded-md border border-border bg-background p-4">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm font-medium">
                      {activeRuns.length > 1 ? `Results — ${doneCount}/${activeRuns.length} finished` : 'Result'}
                      {failedCount > 0 && <span className="ml-2 text-xs text-red-500">{failedCount} failed</span>}
                    </p>
                    <button onClick={() => setActiveRuns([])} className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
                  </div>
                  <div className="space-y-3">
                    {activeRuns.map((target) => {
                      const run = runsById.get(target.runId);
                      const status = run?.status ?? 'pending';
                      const done = TERMINAL_STATUSES.includes(status);
                      return (
                        <div key={target.runId} className="rounded border border-border">
                          <div className="flex items-center gap-2 px-3 py-2 text-sm">
                            {!done ? (
                              <><Loader2 size={13} className="animate-spin text-muted-foreground" />
                                <span className="text-muted-foreground">{status === 'pending' ? 'Queued…' : 'Running…'}</span></>
                            ) : (
                              <span className={status === 'success' ? 'text-emerald-500 font-medium' : 'text-red-500 font-medium'}>
                                {status === 'success' ? 'Success' : 'Failed'}
                                {run?.exitCode != null && ` · exit ${run.exitCode}`}
                                {run?.durationMs != null && ` · ${(run.durationMs / 1000).toFixed(1)}s`}
                              </span>
                            )}
                            <span className="ml-auto text-xs text-muted-foreground">{target.serverName}</span>
                          </div>
                          {run?.stdout && (
                            <pre className="max-h-56 overflow-auto border-t border-border bg-muted p-2 text-xs font-mono whitespace-pre-wrap">{run.stdout}</pre>
                          )}
                          {run?.stderr && (
                            <pre className="max-h-40 overflow-auto border-t border-border bg-red-500/10 p-2 text-xs font-mono text-red-500 whitespace-pre-wrap">{run.stderr}</pre>
                          )}
                          {done && !run?.stdout && !run?.stderr && (
                            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">No output.</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
