import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api.js';
import type { AuditLogEntry, AuditLogFilters, AuditExportFormat } from '@smt/shared';
import { Download, Film, ScrollText } from 'lucide-react';
import { toast } from 'sonner';
import { relativeTime } from '@/lib/utils.js';
import AuditSettings from '@/components/settings/AuditSettings.js';

const emptyFilters: AuditLogFilters = { from: '', to: '', action: '', actorEmail: '' };

/** Only the filters that are set, as a query string. */
function filterQuery(f: AuditLogFilters): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);
  return params.toString();
}

/** The recording an entry points at: a connect or command run records one, and views/downloads name it. */
function recordingOf(e: AuditLogEntry): string | undefined {
  const fromMeta = e.metadata?.recordingId;
  if (typeof fromMeta === 'string') return fromMeta;
  // A saved command run on one server; a run on several links from the Recordings page instead
  const many = e.metadata?.recordingIds;
  if (Array.isArray(many) && many.length === 1 && typeof many[0] === 'string') return many[0];
  if (e.resourceType === 'recording' && e.action !== 'recording.delete') return e.resourceId;
  return undefined;
}

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<AuditLogFilters>(emptyFilters);
  const [filters, setFilters] = useState<AuditLogFilters>(emptyFilters);
  const [exporting, setExporting] = useState<AuditExportFormat | null>(null);
  const limit = 50;
  const query = filterQuery(filters);

  const { data, isLoading, error } = useQuery<{ items: AuditLogEntry[]; total: number }>({
    queryKey: ['audit-log', page, query],
    queryFn: () => api.get(`/audit?page=${page}&limit=${limit}${query ? `&${query}` : ''}`),
  });

  const totalPages = Math.ceil((data?.total ?? 0) / limit);

  async function exportLog(format: AuditExportFormat) {
    setExporting(format);
    try {
      const date = new Date().toISOString().slice(0, 10);
      await api.download(`/audit/export?format=${format}${query ? `&${query}` : ''}`, `audit-${date}.${format}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(null);
    }
  }

  const field = 'rounded-md border border-input bg-background px-2 py-1.5 text-sm';

  return (
    <div className="p-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Audit Log</h1>
          <p className="text-muted-foreground text-sm">Activity history for your organization</p>
        </div>
        <div className="flex gap-2">
          {(['csv', 'jsonl'] as const).map((format) => (
            <button
              key={format}
              onClick={() => exportLog(format)}
              disabled={exporting !== null}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
              title="Export every event matching the filters"
            >
              <Download size={14} /> {format === 'csv' ? 'CSV' : 'JSON Lines'}
            </button>
          ))}
        </div>
      </div>

      <form
        className="mb-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); setPage(1); setFilters(draft); }}
      >
        <label className="text-xs text-muted-foreground">
          From
          <input type="date" value={draft.from} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} className={`${field} block mt-1`} />
        </label>
        <label className="text-xs text-muted-foreground">
          To
          <input type="date" value={draft.to} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} className={`${field} block mt-1`} />
        </label>
        <label className="text-xs text-muted-foreground">
          Action
          <input value={draft.action} onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value.trim() }))} placeholder="user.* or server.create" className={`${field} block mt-1 w-48`} />
        </label>
        <label className="text-xs text-muted-foreground">
          Actor email
          <input value={draft.actorEmail} onChange={(e) => setDraft((d) => ({ ...d, actorEmail: e.target.value }))} className={`${field} block mt-1 w-56`} />
        </label>
        <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">Apply</button>
        {query && (
          <button type="button" onClick={() => { setDraft(emptyFilters); setFilters(emptyFilters); setPage(1); }} className="px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground">
            Clear
          </button>
        )}
      </form>

      {error ? (
        <p className="text-sm text-red-500">{(error as Error).message}</p>
      ) : isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : data?.items.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-muted-foreground">
          <ScrollText size={40} className="mb-3 opacity-30" />
          <p>{query ? 'No events match these filters.' : 'No audit events recorded yet.'}</p>
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
                    <td className="px-4 py-3 text-xs text-muted-foreground font-mono max-w-xs">
                      <div className="flex items-center gap-2">
                        <span className="truncate">{e.metadata ? JSON.stringify(e.metadata) : ''}</span>
                        {recordingOf(e) && (
                          <Link
                            to={`/recordings/${recordingOf(e)}`}
                            title="Play the recording"
                            className="flex shrink-0 items-center gap-1 font-sans text-primary hover:underline"
                          >
                            <Film size={12} /> Recording
                          </Link>
                        )}
                      </div>
                    </td>
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

      <div className="max-w-2xl">
        <AuditSettings />
      </div>
    </div>
  );
}
