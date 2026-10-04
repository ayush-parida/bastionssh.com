import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccessRequest, AccessRequestSettings, AccessRequestStatus, DecideAccessRequest } from '@smt/shared';
import { Check, Clock, KeyRound, Settings2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { cn, relativeTime } from '@/lib/utils.js';
import { DURATION_OPTIONS, formatMinutes } from '@/lib/access.js';
import { useAuthStore, useHasRole } from '@/store/auth.js';
import { ExpiryBadge } from './ExpiryBadge.js';
import { durationChoices, RequestAccessDialog, useRequestableServers } from './RequestAccessDialog.js';

const STATUS_STYLE: Record<AccessRequestStatus, string> = {
  pending: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  approved: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  denied: 'bg-red-500/10 text-red-600 dark:text-red-400',
  expired: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground',
};

function StatusPill({ request }: { request: AccessRequest }) {
  return (
    <span className={cn('rounded px-2 py-0.5 text-xs font-medium capitalize', STATUS_STYLE[request.status])}>
      {request.status}
    </span>
  );
}

function serverNames(request: AccessRequest): string {
  if (request.resourceType === 'cluster') {
    return request.clusters.map((c) => c.name ?? 'deleted cluster').join(', ');
  }
  return request.servers.map((s) => s.name ?? 'deleted server').join(', ');
}

/** One request: who, what, why, and where it stands. */
function RequestRow({ request, actions }: { request: AccessRequest; actions?: React.ReactNode }) {
  const accessEnds = request.status === 'approved' ? request.expiresAt : null;
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium truncate">{request.userDisplayName || request.userEmail}</span>
          <StatusPill request={request} />
          {accessEnds && <ExpiryBadge expiresAt={accessEnds} />}
        </div>
        <p className="text-sm">
          {serverNames(request)}
          <span className="text-muted-foreground">
            {' '}· {formatMinutes(request.approvedMinutes ?? request.durationMinutes)}
            {request.approvedMinutes != null && request.approvedMinutes < request.durationMinutes &&
              ` (asked for ${formatMinutes(request.durationMinutes)})`}
          </span>
        </p>
        <p className="text-xs text-muted-foreground break-words">“{request.reason}”</p>
        <p className="text-xs text-muted-foreground">
          {request.userEmail} · asked {relativeTime(request.createdAt)}
          {request.decidedByEmail && ` · ${request.status} by ${request.decidedByEmail}`}
          {request.decisionNote && ` — ${request.decisionNote}`}
        </p>
      </div>
      {actions}
    </div>
  );
}

/** Approve (optionally for less time) or deny a pending request. */
function DecideActions({ request }: { request: AccessRequest }) {
  const qc = useQueryClient();
  const [minutes, setMinutes] = useState(request.durationMinutes);
  const choices = DURATION_OPTIONS.filter((o) => o.minutes < request.durationMinutes);

  const mutation = useMutation({
    mutationFn: ({ verb, body }: { verb: 'approve' | 'deny'; body: DecideAccessRequest }) =>
      api.post<AccessRequest>(`/access-requests/${request.id}/${verb}`, body),
    onSuccess: (_res, { verb }) => {
      qc.invalidateQueries({ queryKey: ['access-requests'] });
      qc.invalidateQueries({ queryKey: ['team-members'] });
      qc.invalidateQueries({ queryKey: ['member-access', request.userId] });
      toast.success(verb === 'approve' ? 'Access granted' : 'Request denied');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="flex shrink-0 items-center gap-2">
      <select
        value={minutes}
        onChange={(e) => setMinutes(Number(e.target.value))}
        title="Approve for"
        className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
      >
        <option value={request.durationMinutes}>{formatMinutes(request.durationMinutes)} (as asked)</option>
        {choices.map((o) => (
          <option key={o.minutes} value={o.minutes}>{o.label}</option>
        ))}
      </select>
      <button
        onClick={() => mutation.mutate({ verb: 'approve', body: { durationMinutes: minutes } })}
        disabled={mutation.isPending}
        className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-600/90 disabled:opacity-50"
      >
        <Check size={12} /> Approve
      </button>
      <button
        onClick={() => {
          const note = prompt('Deny this request? Optionally say why:');
          if (note !== null) mutation.mutate({ verb: 'deny', body: note.trim() ? { note: note.trim() } : {} });
        }}
        disabled={mutation.isPending}
        className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50"
      >
        <X size={12} /> Deny
      </button>
    </div>
  );
}

/** Admins: whether restricted members see server names, and the longest request allowed. */
function RequestPolicy({ settings }: { settings: AccessRequestSettings }) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: Partial<AccessRequestSettings>) => api.patch<AccessRequestSettings>('/access-requests/settings', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['requestable-servers'] });
      toast.success('Access request policy updated');
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const maxChoices = durationChoices(10080).filter((o) => o.minutes >= 30);

  return (
    <div className="mb-4 rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start gap-3">
        <Settings2 size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Show server names to restricted members</p>
          <p className="text-xs text-muted-foreground">
            Lets them pick servers to ask for. Only names are shown — never addresses, tags or anything else. When off,
            they can only ask for more time on servers they already have, and you grant new ones from their access settings.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={settings.restrictedSeeServerNames}
          onClick={() => mutation.mutate({ restrictedSeeServerNames: !settings.restrictedSeeServerNames })}
          disabled={mutation.isPending}
          className={cn(
            'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50',
            settings.restrictedSeeServerNames ? 'bg-primary' : 'bg-muted-foreground/30',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 size-4 rounded-full bg-background shadow transition-transform',
              settings.restrictedSeeServerNames ? 'translate-x-4' : 'translate-x-0.5',
            )}
          />
        </button>
      </div>
      <div className="flex items-center gap-3 pl-7">
        <label className="text-sm">Longest access a member may ask for</label>
        <select
          value={settings.maxRequestMinutes}
          onChange={(e) => mutation.mutate({ maxRequestMinutes: Number(e.target.value) })}
          disabled={mutation.isPending}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {!maxChoices.some((o) => o.minutes === settings.maxRequestMinutes) && (
            <option value={settings.maxRequestMinutes}>{formatMinutes(settings.maxRequestMinutes)}</option>
          )}
          {maxChoices.map((o) => (
            <option key={o.minutes} value={o.minutes}>{o.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

/**
 * Just-in-time access on the Team page. Restricted members ask for servers and
 * follow their requests; admins decide pending ones and set the policy.
 */
export default function AccessRequests() {
  const qc = useQueryClient();
  const isAdmin = useHasRole('admin');
  const currentUser = useAuthStore((s) => s.user);
  const [requesting, setRequesting] = useState(false);
  const [showPolicy, setShowPolicy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const { data: requestable } = useRequestableServers();
  const restricted = requestable?.restricted ?? false;

  const { data: requests } = useQuery<AccessRequest[]>({
    queryKey: ['access-requests'],
    queryFn: () => api.get('/access-requests'),
    enabled: isAdmin || restricted,
    // New requests and lapsing ones show up without a reload
    refetchInterval: 60_000,
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.post<AccessRequest>(`/access-requests/${id}/cancel`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['access-requests'] });
      toast.success('Request cancelled');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (!isAdmin && !restricted) return null;

  const all = requests ?? [];
  const pending = all.filter((r) => r.status === 'pending');
  const decided = all.filter((r) => r.status !== 'pending');
  const history = showHistory ? decided : decided.slice(0, 5);

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold">Access requests</h2>
        <div className="flex items-center gap-2">
          {isAdmin && requestable && (
            <button
              onClick={() => setShowPolicy((v) => !v)}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
            >
              <Settings2 size={14} /> Policy
            </button>
          )}
          {restricted && (
            <button
              onClick={() => setRequesting(true)}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <KeyRound size={14} /> Request access
            </button>
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        {isAdmin
          ? 'Members limited to some servers can ask for others for a while. Approved access ends on its own.'
          : 'You can use only some servers. Ask for others for as long as you need them; access ends on its own.'}
      </p>

      {isAdmin && showPolicy && requestable && <RequestPolicy settings={requestable.settings} />}

      <div className="rounded-lg border border-border bg-card divide-y divide-border">
        {pending.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
            <Clock size={14} /> No pending requests.
          </div>
        ) : (
          pending.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              actions={
                r.userId === currentUser?.id ? (
                  <button
                    onClick={() => cancelMutation.mutate(r.id)}
                    disabled={cancelMutation.isPending}
                    className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
                  >
                    Cancel
                  </button>
                ) : isAdmin ? (
                  <DecideActions request={r} />
                ) : undefined
              }
            />
          ))
        )}
      </div>

      {decided.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium mb-2 text-muted-foreground">Recent</h3>
          <div className="rounded-lg border border-border bg-card divide-y divide-border">
            {history.map((r) => <RequestRow key={r.id} request={r} />)}
          </div>
          {decided.length > 5 && (
            <button
              onClick={() => setShowHistory((v) => !v)}
              className="mt-2 text-xs text-muted-foreground hover:text-foreground"
            >
              {showHistory ? 'Show less' : `Show all ${decided.length}`}
            </button>
          )}
        </div>
      )}

      {requesting && <RequestAccessDialog onClose={() => setRequesting(false)} />}
    </section>
  );
}
