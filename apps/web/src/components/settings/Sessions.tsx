import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { relativeTime } from '@/lib/utils.js';
import type { SessionInfo } from '@smt/shared';
import { Monitor, LogOut } from 'lucide-react';
import { toast } from 'sonner';

/** "Chrome on macOS" from a user-agent string — enough to recognise a device, not a parser. */
function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? ua.slice(0, 60);
}

export default function Sessions() {
  const qc = useQueryClient();

  const { data: sessions } = useQuery<SessionInfo[]>({
    queryKey: ['auth-sessions'],
    queryFn: () => api.get('/auth/sessions'),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['auth-sessions'] }); toast.success('Session signed out'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const revokeOthersMutation = useMutation({
    mutationFn: () => api.delete<{ revoked: number }>('/auth/sessions'),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['auth-sessions'] });
      toast.success(`Signed out of ${res.revoked} other session${res.revoked === 1 ? '' : 's'}`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const others = sessions?.filter((s) => !s.current).length ?? 0;

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold">Your sessions</h2>
        {others > 0 && (
          <button
            onClick={() => { if (confirm('Sign out every other browser?')) revokeOthersMutation.mutate(); }}
            disabled={revokeOthersMutation.isPending}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            <LogOut size={14} /> Sign out other sessions
          </button>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Browsers currently signed in to your account. Sign out any you don't recognise.
      </p>

      <div className="rounded-lg border border-border bg-card divide-y divide-border">
        {!sessions?.length ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No active sessions.</p>
        ) : (
          sessions.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-3">
              <Monitor size={16} className="text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {describeAgent(s.userAgent)}
                  {s.current && (
                    <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                      This browser
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {s.ipAddress ?? 'Unknown IP'}
                  {' · '}
                  {s.lastSeenAt ? `active ${relativeTime(s.lastSeenAt)}` : `signed in ${relativeTime(s.createdAt)}`}
                </p>
              </div>
              {!s.current && (
                <button
                  onClick={() => revokeMutation.mutate(s.id)}
                  className="text-red-500 hover:text-red-600"
                  title="Sign out this session"
                >
                  <LogOut size={14} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
