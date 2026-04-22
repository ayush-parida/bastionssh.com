import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import type { AuditLogEntry } from '@smt/shared';
import { ScrollText } from 'lucide-react';
import { relativeTime } from '@/lib/utils.js';

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const limit = 50;

  const { data, isLoading } = useQuery<{ items: AuditLogEntry[]; total: number }>({
    queryKey: ['audit-log', page],
    queryFn: () => api.get(`/audit?page=${page}&limit=${limit}`),
  });

  const totalPages = Math.ceil((data?.total ?? 0) / limit);

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Audit Log</h1>
        <p className="text-muted-foreground text-sm">Activity history for your organization</p>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : data?.items.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-muted-foreground">
          <ScrollText size={40} className="mb-3 opacity-30" />
          <p>No audit events recorded yet.</p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/50">
                <tr>
                  {['Time', 'Actor', 'Action', 'Resource', 'Details'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data?.items.map((e) => (
                  <tr key={e.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap" title={new Date(e.createdAt).toISOString()}>
                      {relativeTime(e.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{(e as AuditLogEntry & { actorEmail?: string }).actorEmail ?? e.actorId}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono bg-muted">{e.action}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{e.resourceType}{e.resourceName ? ` · ${e.resourceName}` : ''}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground font-mono truncate max-w-xs">{e.metadata ? JSON.stringify(e.metadata) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-muted-foreground">Page {page} of {totalPages}</p>
              <div className="flex gap-2">
                <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-muted">Previous</button>
                <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-muted">Next</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
