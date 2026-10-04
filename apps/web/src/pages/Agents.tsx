import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { isPasskeyCancel, passkeyErrorMessage, withStepUp } from '@/lib/passkeys.js';
import { useModule } from '@/hooks/useModules.js';
import type { Agent, AgentStatus, CreatedAgent, CreateAgentRequest } from '@smt/shared';
import { Plus, RadioTower, Copy, X, TriangleAlert, Ban } from 'lucide-react';
import { toast } from 'sonner';

const QUERY_KEY = ['agents'];

const STATUS_STYLE: Record<AgentStatus, { label: string; className: string }> = {
  online: { label: 'Online', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  offline: { label: 'Offline', className: 'bg-muted text-muted-foreground' },
  revoked: { label: 'Revoked', className: 'bg-red-500/10 text-red-500' },
};

/** `22, 2222` → [22, 2222]; null when anything in it is not a port. */
function parsePorts(input: string): number[] | null {
  const parts = input.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const ports = parts.map(Number);
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) return null;
  return [...new Set(ports)];
}

export default function AgentsPage() {
  const qc = useQueryClient();
  const isAdmin = useModule('agents', 'manage');
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [ports, setPorts] = useState('22');
  const [created, setCreated] = useState<CreatedAgent | null>(null);

  const { data: agents, isLoading } = useQuery<Agent[]>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/agents'),
    enabled: isAdmin,
    refetchInterval: 15_000,
  });

  const createMutation = useMutation({
    // An agent token is a standing way into the network: passkey holders step up first
    mutationFn: (body: CreateAgentRequest) => withStepUp(() => api.post<CreatedAgent>('/agents', body)),
    onSuccess: (agent) => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      setShowForm(false);
      setName('');
      setPorts('22');
      setCreated(agent);
    },
    onError: (err: Error) => { if (!isPasskeyCancel(err)) toast.error(passkeyErrorMessage(err)); },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.post<Agent>(`/agents/${id}/revoke`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast.success('Agent revoked');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  async function copy(value: string, message = 'Copied') {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(message);
    } catch {
      toast.message('Select and copy it below', { duration: 10_000 });
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const allowedPorts = parsePorts(ports);
    if (!allowedPorts) {
      toast.error('Ports must be a comma-separated list of numbers between 1 and 65535');
      return;
    }
    createMutation.mutate({ name, allowedPorts });
  }

  if (!isAdmin) {
    return (
      <div className="p-6 max-w-5xl">
        <h1 className="text-2xl font-bold mb-1">Agents</h1>
        <p className="text-muted-foreground text-sm">Only admins can manage connectivity agents.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">Agents</h1>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus size={15} /> New agent
        </button>
      </div>
      <p className="text-muted-foreground text-sm mb-6">
        Reach servers behind a firewall or NAT. The agent runs on the private host, dials out to this app,
        and tunnels SSH to its own loopback — nothing needs to accept inbound connections. Host keys are
        still verified end to end; the agent never sees credentials.
      </p>

      {created && (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="flex items-start gap-2">
            <TriangleAlert size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                Run this on {created.name} now — the token in it won't be shown again
              </p>
              <p className="text-xs text-muted-foreground mb-2">
                It installs the agent as a systemd service (Node.js 18+ required). Paste all three lines: the
                token goes to the installer on stdin, never on a command line, and is kept in a root-only file
                on the host. Only a hash of the token is stored here; if you lose it, revoke this agent and
                create another.
              </p>
              <div className="flex items-start gap-2">
                <code className="flex-1 min-w-0 whitespace-pre-wrap break-all rounded bg-background px-2 py-1.5 text-xs font-mono select-all">
                  {created.installCommand}
                </code>
                <button
                  onClick={() => copy(created.installCommand, 'Install command copied')}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs hover:bg-muted"
                >
                  <Copy size={12} /> Copy
                </button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Then point servers at it: edit a server, choose this agent under <em>Connect via</em>, and set
                its port to the one sshd listens on locally.
              </p>
            </div>
            <button onClick={() => setCreated(null)} className="text-muted-foreground hover:text-foreground">
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <div className="mb-6 rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold mb-3">New agent</h2>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input
                  type="text"
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="office-nas"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Allowed local ports</label>
                <input
                  type="text"
                  required
                  value={ports}
                  onChange={(e) => setPorts(e.target.value)}
                  placeholder="22"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              The agent only ever connects to 127.0.0.1 on these ports. They are written into the host's config
              by the install command; the agent enforces them itself.
            </p>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={createMutation.isPending}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {createMutation.isPending ? 'Creating…' : 'Create agent'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : !agents?.length ? (
          <div className="flex flex-col items-center py-12 text-muted-foreground">
            <RadioTower size={36} className="mb-3 opacity-30" />
            <p className="text-sm">No agents yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {agents.map((a) => {
              const style = STATUS_STYLE[a.status];
              return (
                <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium flex items-center gap-2">
                      {a.name}
                      <span className={`rounded px-1.5 py-0.5 text-xs ${style.className}`}>{style.label}</span>
                      {a.version && <span className="text-xs text-muted-foreground font-mono">v{a.version}</span>}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {a.serverCount} server{a.serverCount === 1 ? '' : 's'}
                      {a.connection
                        ? ` · connected since ${new Date(a.connection.connectedAt).toLocaleString()} from ${a.connection.remoteAddress}` +
                          (a.connection.allowedPorts.length ? ` · ports ${a.connection.allowedPorts.join(', ')}` : '') +
                          ` · ${a.connection.openStreams} open`
                        : a.lastSeenAt
                          ? ` · last seen ${new Date(a.lastSeenAt).toLocaleString()}`
                          : ' · never connected'}
                      {a.revokedAt && ` · revoked ${new Date(a.revokedAt).toLocaleString()}`}
                    </p>
                  </div>
                  {a.status !== 'revoked' && (
                    <button
                      onClick={() => {
                        const note = a.serverCount
                          ? ` Its ${a.serverCount} server${a.serverCount === 1 ? '' : 's'} become unreachable until pointed at another agent.`
                          : '';
                        if (confirm(`Revoke ${a.name}? Its connection is dropped and its token stops working for good.${note}`)) {
                          revokeMutation.mutate(a.id);
                        }
                      }}
                      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-red-500 hover:bg-red-500/10"
                      title="Revoke"
                    >
                      <Ban size={12} /> Revoke
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
