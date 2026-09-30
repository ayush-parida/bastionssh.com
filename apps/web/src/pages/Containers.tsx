import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { DockerContainer, DockerContainerState, DockerFleetResponse, DockerFleetServer } from '@smt/shared';
import { Boxes, Container, Radar, RefreshCw, Search, ServerCrash } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { formatPorts, shortId, uptimeText } from '@/lib/docker.js';
import { StateBadge } from '@/components/docker/ContainersTable.js';

type StateFilter = 'all' | 'running' | 'stopped' | 'unhealthy' | 'restarting' | 'paused';
const STATE_FILTERS: { id: StateFilter; label: string }[] = [
  { id: 'all', label: 'Any state' },
  { id: 'running', label: 'Running' },
  { id: 'unhealthy', label: 'Unhealthy' },
  { id: 'restarting', label: 'Restarting' },
  { id: 'paused', label: 'Paused' },
  { id: 'stopped', label: 'Stopped' },
];
const STOPPED: DockerContainerState[] = ['exited', 'dead', 'created'];

function matchesState(c: DockerContainer, filter: StateFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'unhealthy':
      return c.health === 'unhealthy';
    case 'stopped':
      return STOPPED.includes(c.state);
    default:
      return c.state === filter;
  }
}

/** The server refuses more server ids per request (routes/docker-fleet.ts); a larger fleet is checked in turns. */
const MAX_CHECK = 200;

const fleetKey = (all: boolean) => ['docker-fleet', all] as const;

/**
 * Containers across every server the member can access (the fleet view).
 * Each server answers on its own: a slow or broken one shows as an error
 * below the table, never an empty page. Servers whose Docker tab was never
 * opened are not asked until someone checks them. A row opens the container
 * on its server's Docker page.
 */
export default function ContainersPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(true);
  const [search, setSearch] = useState('');
  const [state, setState] = useState<StateFilter>('all');
  const [serverId, setServerId] = useState('');

  const fleet = useQuery<DockerFleetResponse>({
    queryKey: fleetKey(showAll),
    queryFn: () => api.get(`/docker/containers?all=${showAll ? 1 : 0}`),
    refetchInterval: 60_000,
  });

  // Asking for servers by id detects Docker on them; afterwards they are part of the default list
  const check = useMutation({
    mutationFn: (ids: string[]) =>
      api.get<DockerFleetResponse>(`/docker/containers?all=${showAll ? 1 : 0}&serverIds=${ids.map(encodeURIComponent).join(',')}`),
    onSuccess: (res) => {
      const found = res.servers.filter((s) => s.ok).length;
      toast.success(found ? `Docker found on ${found} of ${res.servers.length} server(s)` : 'Docker was not found on these servers');
      qc.invalidateQueries({ queryKey: ['docker-fleet'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const servers = fleet.data?.servers ?? [];
  const failed = servers.filter((s) => !s.ok);
  const notDetected = fleet.data?.skipped.filter((s) => s.reason === 'not_detected') ?? [];

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (fleet.data?.servers ?? [])
      .filter((s) => !serverId || s.serverId === serverId)
      .flatMap((s) => s.containers.map((c) => ({ server: s, container: c })))
      .filter(
        ({ container: c }) =>
          matchesState(c, state) &&
          (!q ||
            c.name.toLowerCase().includes(q) ||
            c.image.toLowerCase().includes(q) ||
            (c.composeProject ?? '').toLowerCase().includes(q)),
      )
      .sort(
        (a, b) =>
          Number(b.container.health === 'unhealthy') - Number(a.container.health === 'unhealthy') ||
          Number(b.container.state === 'running') - Number(a.container.state === 'running') ||
          a.container.name.localeCompare(b.container.name) ||
          a.server.serverName.localeCompare(b.server.serverName),
      );
  }, [fleet.data, search, state, serverId]);

  const all = servers.flatMap((s) => s.containers);
  const tiles = [
    { label: 'Containers', value: all.length },
    { label: 'Running', value: all.filter((c) => c.state === 'running').length },
    { label: 'Unhealthy', value: all.filter((c) => c.health === 'unhealthy').length, warn: true },
    { label: 'Servers', value: servers.length - failed.length },
  ];

  return (
    <div className="p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Container size={22} className="text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Containers</h1>
            <p className="text-sm text-muted-foreground">Docker containers across the servers you can access</p>
          </div>
        </div>
        <button
          onClick={() => fleet.refetch()}
          disabled={fleet.isFetching}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw size={14} className={cn(fleet.isFetching && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {fleet.isLoading ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          <Radar size={15} className="animate-pulse" /> Asking your servers…
        </div>
      ) : fleet.error ? (
        <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          {(fleet.error as Error).message}
        </p>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            {tiles.map((t) => (
              <div key={t.label} className="rounded-lg border border-border bg-card p-4">
                <p className={cn('text-2xl font-bold leading-tight', t.warn && t.value > 0 && 'text-red-600')}>{t.value}</p>
                <p className="text-xs text-muted-foreground">{t.label}</p>
              </div>
            ))}
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter by name, image or project"
                className="w-64 rounded-md border border-input bg-background py-1.5 pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <select
              value={state}
              onChange={(e) => setState(e.target.value as StateFilter)}
              aria-label="State"
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            >
              {STATE_FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <select
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
              aria-label="Server"
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            >
              <option value="">All servers</option>
              {servers.map((s) => (
                <option key={s.serverId} value={s.serverId}>
                  {s.serverName}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Show stopped
            </label>
          </div>

          {rows.length === 0 ? (
            <div className="flex flex-col items-center rounded-lg border border-border bg-card py-12 text-muted-foreground">
              <Boxes size={32} className="mb-2 opacity-30" />
              <p className="text-sm">
                {servers.length === 0
                  ? 'No server with Docker yet. Open a server’s Docker page, or check the servers below.'
                  : all.length === 0
                    ? 'No containers.'
                    : 'No container matches.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Name</th>
                    <th className="px-4 py-2 font-medium">Server</th>
                    <th className="px-4 py-2 font-medium">Image</th>
                    <th className="px-4 py-2 font-medium">State</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Ports</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map(({ server, container: c }) => (
                    <tr
                      key={`${server.serverId}:${c.id}`}
                      onClick={() => navigate(`/servers/${server.serverId}/docker?container=${encodeURIComponent(c.id)}`)}
                      className="cursor-pointer hover:bg-muted/50"
                    >
                      <td className="px-4 py-2">
                        <p className="font-medium">{c.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {shortId(c.id)}
                          {c.composeProject && (
                            <span className="ml-2 rounded bg-muted px-1 font-sans" title="Compose project / service">
                              {c.composeProject}
                              {c.composeService ? ` / ${c.composeService}` : ''}
                            </span>
                          )}
                        </p>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-xs">{server.serverName}</td>
                      <td className="max-w-[16rem] truncate px-4 py-2 font-mono text-xs" title={c.image}>
                        {c.image}
                      </td>
                      <td className="px-4 py-2">
                        <StateBadge container={c} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground">{uptimeText(c.status)}</td>
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{formatPorts(c).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {failed.length > 0 && <FailedServers servers={failed} />}

          {notDetected.length > 0 && (
            <div className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-4 text-sm">
              <Radar size={15} className="shrink-0 text-muted-foreground" />
              <p className="min-w-0 flex-1 text-muted-foreground">
                Not checked for Docker yet: {notDetected.map((s) => s.serverName).join(', ')}
              </p>
              <button
                onClick={() => check.mutate(notDetected.slice(0, MAX_CHECK).map((s) => s.serverId))}
                disabled={check.isPending}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              >
                {check.isPending ? 'Checking…' : 'Check them'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FailedServers({ servers }: { servers: DockerFleetServer[] }) {
  return (
    <div className="mt-6">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <ServerCrash size={15} className="text-amber-500" />
        {servers.length === 1 ? 'One server did not answer' : `${servers.length} servers did not answer`}
      </h2>
      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        {servers.map((s) => (
          <div key={s.serverId} className="flex items-start gap-3 p-3 text-sm">
            <Link to={`/servers/${s.serverId}/docker`} className="shrink-0 font-medium hover:underline">
              {s.serverName}
            </Link>
            <p className="min-w-0 flex-1 break-words text-muted-foreground">{s.error}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
