import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { DockerPruneEstimate, DockerPrunePreview, DockerPruneRequest, DockerPruneResult } from '@smt/shared';
import { Eraser, Loader2, TriangleAlert, X } from 'lucide-react';
import { api } from '@/lib/api.js';
import { formatBytes } from '@/lib/utils.js';
import { dockerPath } from '@/lib/docker.js';

type Kind = 'containers' | 'images' | 'volumes' | 'networks';

function estimate(e: DockerPruneEstimate): string {
  if (e.count === 0) return 'nothing';
  return `${e.count} · ${e.size === null ? '' : formatBytes(e.size, 1)}`.replace(/ · $/, '');
}

/**
 * Reclaim space (admins, when the org allows pruning). A dry run comes first:
 * what each kind would remove, from the daemon's disk usage; only then the
 * prune, and what it actually reclaimed.
 */
export default function PruneDialog({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [kinds, setKinds] = useState<Record<Kind, boolean>>({ containers: true, images: true, volumes: false, networks: true });
  const [allImages, setAllImages] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useQuery<DockerPrunePreview>({
    queryKey: ['docker', serverId, 'prune-preview'],
    queryFn: () => api.get(dockerPath(serverId, '/prune')),
    staleTime: 0,
  });

  async function prune() {
    setRunning(true);
    setError(null);
    try {
      const body: DockerPruneRequest = { ...kinds, dangling: !allImages };
      const result = await api.post<DockerPruneResult>(dockerPath(serverId, '/prune'), body);
      const removed = [
        result.containers && `${result.containers.deleted} containers`,
        result.images && `${result.images.deleted} images`,
        result.volumes && `${result.volumes.deleted} volumes`,
        result.networks && `${result.networks.deleted} networks`,
      ].filter(Boolean);
      toast.success(`Reclaimed ${formatBytes(result.reclaimed, 1)} (${removed.join(', ')})`);
      qc.invalidateQueries({ queryKey: ['docker', serverId] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  }

  const p = preview.data;
  const rows: { kind: Kind; label: string; hint: string; value: DockerPruneEstimate | undefined }[] = [
    { kind: 'containers', label: 'Stopped containers', hint: 'Exited, created and dead ones', value: p?.containers },
    {
      kind: 'images',
      label: allImages ? 'Unused images' : 'Dangling images',
      hint: allImages ? 'Every image no container uses, tagged or not' : 'Untagged layers nothing refers to',
      value: allImages ? p?.unusedImages : p?.danglingImages,
    },
    {
      kind: 'volumes',
      label: p?.volumesIncludeNamed ? 'Unused volumes' : 'Unused anonymous volumes',
      hint: p?.volumesIncludeNamed
        ? 'This engine prunes named volumes too — their data is lost'
        : 'Named volumes are kept',
      value: p?.volumes,
    },
    { kind: 'networks', label: 'Unused networks', hint: 'Custom networks no container is attached to', value: p?.networks },
  ];
  const nothingChosen = !Object.values(kinds).some(Boolean);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !running) onClose();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="prune-title"
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Eraser size={16} className="shrink-0 text-primary" />
          <span id="prune-title" className="flex-1 text-sm font-semibold">
            Prune unused objects
          </span>
          <button onClick={onClose} disabled={running} className="text-muted-foreground hover:text-foreground disabled:opacity-40" title="Close">
            <X size={14} />
          </button>
        </div>
        <div className="space-y-3 overflow-y-auto p-4 text-sm">
          {preview.isLoading ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> Working out what would be removed…
            </p>
          ) : preview.error ? (
            <p className="rounded-md bg-red-500/10 px-3 py-2 text-red-600">{(preview.error as Error).message}</p>
          ) : (
            <>
              <p className="text-muted-foreground">Dry run — this is what would be removed:</p>
              <div className="divide-y divide-border rounded-md border border-border">
                {rows.map((r) => (
                  <label key={r.kind} className="flex items-start gap-3 px-3 py-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={kinds[r.kind]}
                      onChange={(e) => setKinds((k) => ({ ...k, [r.kind]: e.target.checked }))}
                    />
                    <span className="flex-1">
                      {r.label}
                      <span className="block text-xs text-muted-foreground">{r.hint}</span>
                    </span>
                    <span className="whitespace-nowrap font-mono text-xs">{r.value ? estimate(r.value) : '—'}</span>
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={allImages} onChange={(e) => setAllImages(e.target.checked)} />
                Images: every unused image, not just dangling ones (like <span className="font-mono">docker image prune -a</span>)
              </label>
              {kinds.volumes && (
                <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                  Volumes hold data. Removed volumes cannot be recovered.
                </p>
              )}
            </>
          )}
          {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-red-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button onClick={onClose} disabled={running} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={() => void prune()}
            disabled={running || !p || nothingChosen}
            className="flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {running && <Loader2 size={14} className="animate-spin" />}
            Prune
          </button>
        </div>
      </div>
    </div>
  );
}
