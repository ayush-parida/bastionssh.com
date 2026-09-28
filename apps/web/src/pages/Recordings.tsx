import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { OrgMember, Server, SessionRecording } from '@smt/shared';
import { Film, Keyboard, Scissors, Terminal as TerminalIcon, Zap } from 'lucide-react';
import { api } from '@/lib/api.js';
import { formatBytes, relativeTime } from '@/lib/utils.js';
import { useHasRole } from '@/store/auth.js';
import RecordingSettings from '@/components/settings/RecordingSettings.js';

export function recordingDuration(r: Pick<SessionRecording, 'startedAt' | 'endedAt'>): string {
  if (!r.endedAt) return 'Live';
  const s = Math.max(0, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Bounds for the list query: `from` at the start of its day, `to` at the end of its day (local time). */
function dayBound(date: string, end: boolean) {
  const d = new Date(`${date}T00:00:00`);
  if (end) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

export default function RecordingsPage() {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const limit = 50;
  const isAdmin = useHasRole('admin');

  const serverId = params.get('serverId') ?? '';
  const userId = params.get('userId') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setPage(1);
  }

  const query = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (serverId) query.set('serverId', serverId);
  if (userId) query.set('userId', userId);
  if (from) query.set('from', dayBound(from, false));
  if (to) query.set('to', dayBound(to, true));

  const { data, isLoading } = useQuery<{ items: SessionRecording[]; total: number }>({
    queryKey: ['recordings', query.toString()],
    queryFn: () => api.get(`/recordings?${query}`),
  });
  const { data: servers } = useQuery<Server[]>({ queryKey: ['servers'], queryFn: () => api.get('/servers') });
  // Everyone else only ever sees their own recordings
  const { data: members } = useQuery<OrgMember[]>({
    queryKey: ['team-members'],
    queryFn: () => api.get('/team/members'),
    enabled: isAdmin,
  });

  const totalPages = Math.ceil((data?.total ?? 0) / limit);
  const inputClass =
    'rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Session Recordings</h1>
        <p className="text-muted-foreground text-sm">
          {isAdmin
            ? 'Terminal sessions and command runs across your organization'
            : 'Your recorded terminal sessions and command runs'}
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted-foreground">
          <span className="mb-1 block">Server</span>
          <select value={serverId} onChange={(e) => setFilter('serverId', e.target.value)} className={inputClass}>
            <option value="">All servers</option>
            {servers?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {isAdmin && (
          <label className="text-xs text-muted-foreground">
            <span className="mb-1 block">User</span>
            <select value={userId} onChange={(e) => setFilter('userId', e.target.value)} className={inputClass}>
              <option value="">Everyone</option>
              {members?.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.email}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-xs text-muted-foreground">
          <span className="mb-1 block">From</span>
          <input type="date" value={from} onChange={(e) => setFilter('from', e.target.value)} className={inputClass} />
        </label>
        <label className="text-xs text-muted-foreground">
          <span className="mb-1 block">To</span>
          <input type="date" value={to} onChange={(e) => setFilter('to', e.target.value)} className={inputClass} />
        </label>
        {(serverId || userId || from || to) && (
          <button
            onClick={() => {
              setParams({}, { replace: true });
              setPage(1);
            }}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Clear
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !data?.items.length ? (
        <div className="flex flex-col items-center py-16 text-muted-foreground">
          <Film size={40} className="mb-3 opacity-30" />
          <p>No recordings match.</p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/50">
                <tr>
                  {['Started', 'Server', 'User', 'Session', 'Duration', 'Size', ''].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.items.map((r) => (
                  <tr key={r.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap" title={r.startedAt}>
                      <Link to={`/recordings/${r.id}`} className="hover:text-foreground hover:underline">
                        {relativeTime(r.startedAt)}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-xs">{r.serverName ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{r.userEmail ?? r.userId}</td>
                    <td className="px-4 py-3 text-xs">
                      <Link to={`/recordings/${r.id}`} className="flex items-center gap-1.5 hover:underline">
                        {r.kind === 'terminal' ? (
                          <>
                            <TerminalIcon size={12} className="shrink-0 text-muted-foreground" /> Terminal
                          </>
                        ) : (
                          <>
                            <Zap size={12} className="shrink-0 text-muted-foreground" />
                            <span className="font-mono truncate max-w-xs" title={r.command ?? ''}>
                              {r.command}
                            </span>
                            <span className="text-muted-foreground">
                              ({r.source === 'ai' ? 'AI' : 'saved command'})
                            </span>
                          </>
                        )}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {r.endedAt ? (
                        recordingDuration(r)
                      ) : (
                        <span className="inline-flex items-center gap-1 text-red-500">
                          <span className="size-1.5 rounded-full bg-red-500 animate-pulse" /> Live
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{formatBytes(r.bytes, 1)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-2">
                        {r.inputRecorded && (
                          <span title="Keystrokes recorded">
                            <Keyboard size={13} />
                          </span>
                        )}
                        {r.truncated && (
                          <span title="Truncated at the size limit">
                            <Scissors size={13} />
                          </span>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </p>
              <div className="flex gap-2">
                <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-muted">
                  Previous
                </button>
                <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-muted">
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <div className="mt-10 max-w-2xl">
        <RecordingSettings />
      </div>
    </div>
  );
}
