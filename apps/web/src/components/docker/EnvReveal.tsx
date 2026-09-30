import { useEffect, useState } from 'react';
import type { DockerEnvReveal } from '@smt/shared';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api.js';
import { dockerPath } from '@/lib/docker.js';
import { passkeyErrorMessage, withStepUp } from '@/lib/passkeys.js';

/**
 * The container's environment, redacted (`children`) until an admin reveals
 * the values: that confirms a passkey first, is audited, and lasts only while
 * the drawer shows this container. Everyone else just sees `children`.
 */
export default function EnvReveal({
  serverId,
  containerId,
  canReveal,
  children,
}: {
  serverId: string;
  containerId: string;
  canReveal: boolean;
  children: React.ReactNode;
}) {
  const [env, setEnv] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Revealed values never carry over to another container
  useEffect(() => {
    setEnv(null);
    setError(null);
  }, [containerId]);

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      const res = await withStepUp(() =>
        api.post<DockerEnvReveal>(dockerPath(serverId, `/containers/${encodeURIComponent(containerId)}/env/reveal`)),
      );
      setEnv(res.env);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : passkeyErrorMessage(err, 'Could not reveal the values'));
    } finally {
      setBusy(false);
    }
  }

  if (!canReveal) return <>{children}</>;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-2">
        {env ? (
          <button onClick={() => setEnv(null)} className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted">
            <EyeOff size={13} /> Hide values
          </button>
        ) : (
          <button
            onClick={() => void reveal()}
            disabled={busy}
            title="Show the real values. Needs a passkey confirmation, and is recorded in the audit log."
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />} Reveal values
          </button>
        )}
      </div>
      {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600">{error}</p>}
      {env ? (
        <div className="space-y-0.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 font-mono text-xs">
          <p className="mb-2 font-sans text-amber-700 dark:text-amber-300">Revealed — this was recorded in the audit log.</p>
          {env.length === 0 && <p className="text-muted-foreground">No variables.</p>}
          {env.map((e, i) => (
            <div key={i} className="select-all break-all">
              {e}
            </div>
          ))}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
