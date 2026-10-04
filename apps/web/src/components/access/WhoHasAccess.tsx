import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ResourceAccessList, ResourceType } from '@smt/shared';
import { Users, X } from 'lucide-react';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { useHasRole } from '@/store/auth.js';
import { LevelBadge, ViaBadge } from './AccessBadges.js';

/**
 * "Who has access" to one resource, and through what (custom roles spec §7):
 * every active member who reaches it, their level and its reasons. Admins
 * only; renders nothing for anyone else.
 */
export function WhoHasAccessPanel({ type, id }: { type: ResourceType; id: string }) {
  const { data, isLoading, error } = useQuery<ResourceAccessList>({
    queryKey: ['who-has-access', type, id],
    queryFn: () => api.get(`/team/access/resource?type=${type}&id=${encodeURIComponent(id)}`),
  });
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-red-500">{(error as Error).message}</p>;
  if (!data?.holders.length) return <p className="text-sm text-muted-foreground">Nobody.</p>;
  return (
    <div className="rounded-md border border-border divide-y divide-border" data-testid="who-has-access">
      {data.holders.map((h) => (
        <div key={h.userId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate">
            {h.displayName} <span className="text-xs text-muted-foreground">{h.email}</span>
          </span>
          <LevelBadge level={h.level} />
          {h.via.map((v, i) => <ViaBadge key={i} reason={v} />)}
        </div>
      ))}
    </div>
  );
}

/** A small "Who has access" button that opens the panel in a dialog. Admins only. */
export function WhoHasAccessButton({
  type,
  id,
  name,
  className,
}: {
  type: ResourceType;
  id: string;
  name: string;
  className?: string;
}) {
  const isAdmin = useHasRole('admin');
  const [open, setOpen] = useState(false);
  if (!isAdmin) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Who has access"
        aria-label={`Who has access to ${name}`}
        className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted', className)}
      >
        <Users size={12} /> Access
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
          <div role="dialog" aria-label={`Who has access to ${name}`} className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl">
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <Users size={16} className="text-primary shrink-0" />
              <span className="flex-1 truncate text-sm font-semibold">Who has access — {name}</span>
              <button onClick={() => setOpen(false)} aria-label="Close" className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <WhoHasAccessPanel type={type} id={id} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
