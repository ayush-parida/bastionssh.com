import { useMemo, useState } from 'react';
import type { DockerContainer } from '@smt/shared';
import { Boxes, Search } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { HEALTH_STYLE, STATE_STYLE, formatPorts, shortId, uptimeText } from '@/lib/docker.js';

export function StateBadge({ container }: { container: DockerContainer }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className={cn('rounded px-1.5 py-0.5 text-xs', STATE_STYLE[container.state])}>{container.state}</span>
      {container.health && (
        <span className={cn('rounded px-1.5 py-0.5 text-xs', HEALTH_STYLE[container.health])}>{container.health}</span>
      )}
    </span>
  );
}

/**
 * Containers on one server. Clicking a row opens it in the drawer; rows are
 * grouped by nothing, sorted running first, then by name. Later phases add
 * row actions through `actions`.
 */
export default function ContainersTable({
  containers,
  showAll,
  onShowAll,
  onSelect,
  selectedId,
  actions,
}: {
  containers: DockerContainer[];
  showAll: boolean;
  onShowAll: (all: boolean) => void;
  onSelect: (container: DockerContainer) => void;
  selectedId?: string | null;
  actions?: (container: DockerContainer) => React.ReactNode;
}) {
  const [search, setSearch] = useState('');
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return containers
      .filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.image.toLowerCase().includes(q) ||
          (c.composeProject ?? '').toLowerCase().includes(q),
      )
      .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.name.localeCompare(b.name));
  }, [containers, search]);

  return (
    <div>
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
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input type="checkbox" checked={showAll} onChange={(e) => onShowAll(e.target.checked)} />
          Show stopped
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center py-12 text-muted-foreground">
          <Boxes size={32} className="mb-2 opacity-30" />
          <p className="text-sm">{search ? 'No container matches.' : showAll ? 'No containers.' : 'No running containers.'}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Image</th>
                <th className="px-4 py-2 font-medium">State</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Ports</th>
                {actions && <th className="px-4 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => onSelect(c)}
                  className={cn('cursor-pointer hover:bg-muted/50', selectedId === c.id && 'bg-muted/60')}
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
                  <td className="max-w-[16rem] truncate px-4 py-2 font-mono text-xs" title={c.image}>
                    {c.image}
                  </td>
                  <td className="px-4 py-2">
                    <StateBadge container={c} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground">{uptimeText(c.status)}</td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{formatPorts(c).join(', ') || '—'}</td>
                  {actions && (
                    <td className="px-4 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                      {actions(c)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
