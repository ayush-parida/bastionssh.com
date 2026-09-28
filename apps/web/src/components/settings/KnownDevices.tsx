import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { relativeTime } from '@/lib/utils.js';
import type { KnownDevice } from '@smt/shared';
import { Laptop, X } from 'lucide-react';
import { toast } from 'sonner';

/** Browsers and networks the account has signed in from. A sign-in from anywhere else is emailed. */
export default function KnownDevices() {
  const qc = useQueryClient();

  const { data: devices } = useQuery<KnownDevice[]>({
    queryKey: ['auth-devices'],
    queryFn: () => api.get('/auth/devices'),
  });

  const forgetMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/devices/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['auth-devices'] }); toast.success('Device forgotten'); },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold mb-1">Known devices</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Where your account has signed in from. When email is set up, a sign-in from a browser or network not on this
        list is emailed to you. Forget one to be told the next time it is used.
      </p>

      <div className="rounded-lg border border-border bg-card divide-y divide-border">
        {!devices?.length ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No devices recorded yet.</p>
        ) : (
          devices.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-4 py-3">
              <Laptop size={16} className="text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{d.label}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {d.ipPrefix} · last used {relativeTime(d.lastSeenAt)} · first seen {relativeTime(d.firstSeenAt)}
                </p>
              </div>
              <button
                onClick={() => forgetMutation.mutate(d.id)}
                className="text-muted-foreground hover:text-foreground"
                title="Forget this device"
              >
                <X size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
