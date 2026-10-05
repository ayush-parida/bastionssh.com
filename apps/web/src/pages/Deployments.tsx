import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Server } from '@smt/shared';
import { ChevronRight, Rocket, Search } from 'lucide-react';
import { api } from '@/lib/api.js';
import { DEPLOY_DOCS } from '@smt/shared';
import DocsLink from '@/components/docs/DocsLink.js';

/**
 * Deployments in navigation: the servers the member can reach, each opening
 * its Deployments tab. Nothing is asked of the servers here — apps are read
 * from one server at a time, when its tab opens (spec §7).
 */
export default function DeploymentsPage() {
  const [search, setSearch] = useState('');
  const servers = useQuery<Server[]>({ queryKey: ['servers'], queryFn: () => api.get('/servers') });
  const q = search.trim().toLowerCase();
  const list = (servers.data ?? []).filter(
    (s) => !q || s.name.toLowerCase().includes(q) || s.host.toLowerCase().includes(q) || s.tags.some((t) => t.toLowerCase().includes(q)),
  );

  return (
    <div className="p-6">
      <div className="mb-1 flex items-center gap-3">
        <Rocket size={22} className="text-primary" />
        <h1 className="text-2xl font-bold">Deployments</h1>
      </div>
      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
        Apps are deployed to a server and live there — config, secrets and releases are files on the server, not in BastionSSH. Pick a server to see
        its apps or set it up. <DocsLink to={DEPLOY_DOCS.overview}>How deployments work</DocsLink>
      </p>
      <label className="mb-4 flex max-w-sm items-center gap-2 rounded-md border border-input bg-background px-2.5 py-1.5">
        <Search size={14} className="text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter servers"
          aria-label="Filter servers"
          className="w-full bg-transparent text-sm focus:outline-none"
        />
      </label>
      {servers.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : servers.error ? (
        <p className="text-sm text-red-600">{(servers.error as Error).message}</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{q ? 'No server matches.' : 'No servers.'}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {list.map((s) => (
            <li key={s.id}>
              <Link to={`/servers/${s.id}/deployments`} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{s.name}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {s.username}@{s.host}
                  </span>
                </span>
                {s.tags.slice(0, 3).map((t) => (
                  <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {t}
                  </span>
                ))}
                <ChevronRight size={14} className="text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
