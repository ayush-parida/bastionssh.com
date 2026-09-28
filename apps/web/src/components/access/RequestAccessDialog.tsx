import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccessRequest, CreateAccessRequest, RequestableServers } from '@smt/shared';
import { KeyRound, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { DURATION_OPTIONS, formatMinutes } from '@/lib/access.js';
import { ExpiryBadge } from './ExpiryBadge.js';

/** What a restricted member may ask for. Shared by the Servers and Team pages. */
export function useRequestableServers() {
  return useQuery<RequestableServers>({
    queryKey: ['requestable-servers'],
    queryFn: () => api.get('/access-requests/servers'),
  });
}

/** Durations up to the org's maximum, with the maximum itself always offered. */
export function durationChoices(max: number) {
  const choices = DURATION_OPTIONS.filter((o) => o.minutes <= max);
  if (!choices.some((o) => o.minutes === max)) choices.push({ minutes: max, label: formatMinutes(max) });
  return choices;
}

/** Ask admins for time-bound access to some servers, with a reason. */
export function RequestAccessDialog({ onClose, initialServerId }: { onClose: () => void; initialServerId?: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useRequestableServers();
  const [selected, setSelected] = useState<Set<string>>(new Set(initialServerId ? [initialServerId] : []));
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState<number | null>(null);

  const max = data?.settings.maxRequestMinutes ?? 480;
  const choices = durationChoices(max);
  // Default to 2 hours (or the org maximum, if lower) — ask for what the task needs
  const duration = minutes ?? Math.min(max, 120);

  const mutation = useMutation({
    mutationFn: (body: CreateAccessRequest) => api.post<AccessRequest>('/access-requests', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['access-requests'] });
      toast.success('Request sent — admins have been notified');
      onClose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  const servers = data?.servers ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({ serverIds: [...selected], reason: reason.trim(), durationMinutes: duration });
        }}
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <KeyRound size={16} className="text-primary shrink-0" />
          <span className="flex-1 truncate text-sm font-semibold">Request server access</span>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">Servers</label>
                <div className="rounded-md border border-border divide-y divide-border max-h-60 overflow-y-auto">
                  {servers.length === 0 ? (
                    <p className="px-3 py-4 text-sm text-muted-foreground">
                      {data?.settings.restrictedSeeServerNames
                        ? 'This organization has no servers yet.'
                        : 'This organization does not list servers you cannot use. Ask an admin to grant access.'}
                    </p>
                  ) : (
                    servers.map((srv) => {
                      const permanent = srv.granted?.expiresAt === null;
                      return (
                        <label
                          key={srv.id}
                          className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50"
                          title={permanent ? 'You already have access to this server' : undefined}
                        >
                          <input
                            type="checkbox"
                            disabled={permanent}
                            checked={permanent || selected.has(srv.id)}
                            onChange={() => toggle(srv.id)}
                          />
                          <span className="flex-1 truncate">{srv.name}</span>
                          {permanent && <span className="text-xs text-muted-foreground">Has access</span>}
                          {srv.granted?.expiresAt && <ExpiryBadge expiresAt={srv.granted.expiresAt} />}
                        </label>
                      );
                    })
                  )}
                </div>
                {!data?.settings.restrictedSeeServerNames && servers.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Only servers you already have are listed; you can ask for more time on them.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">For how long</label>
                <select
                  value={duration}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  {choices.map((o) => (
                    <option key={o.minutes} value={o.minutes}>{o.label}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Counted from approval. An admin may approve a shorter time. The most you can ask for is {formatMinutes(max)}.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Reason</label>
                <textarea
                  required
                  minLength={3}
                  maxLength={500}
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="What do you need to do, e.g. a ticket number"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
            Cancel
          </button>
          <button
            type="submit"
            disabled={mutation.isPending || selected.size === 0 || reason.trim().length < 3}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {mutation.isPending ? 'Sending…' : 'Send request'}
          </button>
        </div>
      </form>
    </div>
  );
}
