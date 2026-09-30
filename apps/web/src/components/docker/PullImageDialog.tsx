import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { DockerPullProgress } from '@smt/shared';
import { Download, Loader2, X } from 'lucide-react';
import { formatBytes } from '@/lib/utils.js';
import { dockerKeys } from '@/lib/docker.js';
import { pullImage } from '@/lib/docker-actions.js';

/**
 * Pull an image onto the server, with progress per layer as the daemon
 * reports it. Closing the dialog while it runs cancels the pull. Only public
 * images, or registries the server is already logged in to, can be pulled.
 */
export default function PullImageDialog({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [image, setImage] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [layers, setLayers] = useState<Map<string, DockerPullProgress>>(new Map());
  const abort = useRef<AbortController | null>(null);

  // Leaving cancels the pull
  useEffect(() => () => abort.current?.abort(), []);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    const ref = image.trim();
    if (!ref) return;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setError(null);
    setStatus(null);
    setLayers(new Map());
    try {
      await pullImage(serverId, { image: ref }, controller.signal, (p) => {
        if (p.id && p.id !== ref && !p.status.startsWith('Pulling from')) {
          setLayers((prev) => new Map(prev).set(p.id!, p));
        } else {
          setStatus(p.status);
        }
      });
      if (controller.signal.aborted) return;
      toast.success(`Pulled ${ref}`);
      qc.invalidateQueries({ queryKey: dockerKeys.images(serverId) });
      qc.invalidateQueries({ queryKey: dockerKeys.info(serverId) });
      onClose();
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abort.current === controller) setRunning(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pull-image-title"
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Download size={16} className="shrink-0 text-primary" />
          <span id="pull-image-title" className="flex-1 text-sm font-semibold">
            Pull image
          </span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" title={running ? 'Cancel the pull' : 'Close'}>
            <X size={14} />
          </button>
        </div>
        <form onSubmit={(e) => void start(e)} className="space-y-3 overflow-y-auto p-4 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Image</span>
            <input
              autoFocus
              value={image}
              onChange={(e) => setImage(e.target.value)}
              disabled={running}
              placeholder="nginx:1.27 or ghcr.io/org/app:tag"
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              Without a tag, <span className="font-mono">latest</span>. Private registries work only if the server is already logged in to them.
            </span>
          </label>

          {(running || status || layers.size > 0) && (
            <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
              {status && <p className="text-muted-foreground">{status}</p>}
              {[...layers.values()].map((l) => (
                <div key={l.id} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 truncate">{l.id}</span>
                  <span className="w-32 shrink-0 truncate text-muted-foreground">{l.status}</span>
                  {l.total ? (
                    <span className="flex flex-1 items-center gap-2">
                      <span className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                        <span
                          className="block h-full bg-primary"
                          style={{ width: `${Math.min(100, Math.round(((l.current ?? 0) / l.total) * 100))}%` }}
                        />
                      </span>
                      <span className="w-16 text-right text-muted-foreground">{formatBytes(l.total, 0)}</span>
                    </span>
                  ) : null}
                </div>
              ))}
              {running && layers.size === 0 && !status && (
                <p className="flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 size={12} className="animate-spin" /> Contacting the registry…
                </p>
              )}
            </div>
          )}
          {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-red-600">{error}</p>}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">
              {running ? 'Cancel pull' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={running || !image.trim()}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {running ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {running ? 'Pulling…' : 'Pull'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
