import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DockerProbeResult } from '@smt/shared';
import { Copy, Radar, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api.js';
import { dockerPath } from '@/lib/docker.js';

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied');
  } catch {
    toast.message('Select the text to copy it');
  }
}

/** The command in a hint (after the last colon), when it has one. */
function commandIn(hint: string): string | null {
  const match = /:\s*(sudo .+)$/.exec(hint);
  return match ? match[1]! : null;
}

/**
 * Why Docker could not be reached, and what to do about it — from a probe
 * result or from a Docker route's error body (`{ error, problem, hint }`).
 */
export function DockerProblem({ error, hint, onRetry }: { error: string; hint?: string | null; onRetry?: () => void }) {
  const command = hint ? commandIn(hint) : null;
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="flex items-start gap-2 text-sm">
        <TriangleAlert size={15} className="mt-0.5 shrink-0 text-amber-500" />
        <span className="break-words">{error}</span>
      </p>
      {hint && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm">
          <p className="flex-1 break-words">{hint}</p>
          <button onClick={() => copy(command ?? hint)} title="Copy" className="shrink-0 text-muted-foreground hover:text-foreground">
            <Copy size={14} />
          </button>
        </div>
      )}
      {onRetry && (
        <button onClick={onRetry} className="mt-3 text-xs text-muted-foreground underline hover:text-foreground">
          Try again
        </button>
      )}
    </div>
  );
}

/** A Docker route's error as `{ error, hint }`, for {@link DockerProblem}. */
export function problemOf(err: unknown): { error: string; hint: string | null; code: string | null } {
  if (err instanceof ApiError) {
    const hint = typeof err.details?.hint === 'string' ? err.details.hint : null;
    return { error: err.message, hint, code: err.code ?? null };
  }
  return { error: err instanceof Error ? err.message : String(err), hint: null, code: null };
}

/** Admin: probe the server for Docker now and record what was found. */
export function DetectDockerButton({
  serverId,
  label = 'Detect Docker',
  onResult,
  className,
}: {
  serverId: string;
  label?: string;
  onResult?: (result: DockerProbeResult) => void;
  className?: string;
}) {
  const qc = useQueryClient();
  const probe = useMutation({
    mutationFn: () => api.post<DockerProbeResult>(dockerPath(serverId, '/probe')),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['docker', serverId] });
      qc.invalidateQueries({ queryKey: ['servers'] });
      if (result.ok) {
        toast.success(`Found ${result.flavor === 'podman' ? 'Podman' : 'Docker'} ${result.version} (${result.transport})`);
      } else {
        toast.error(result.error ?? 'Docker was not found');
      }
      onResult?.(result);
    },
    onError: (err: Error) => toast.error(err.message),
  });
  return (
    <button
      type="button"
      onClick={() => probe.mutate()}
      disabled={probe.isPending}
      title="Look for the Docker daemon on this server over SSH"
      className={
        className ??
        'flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50'
      }
    >
      <Radar size={14} className={probe.isPending ? 'animate-pulse' : undefined} />
      {probe.isPending ? 'Detecting…' : label}
    </button>
  );
}
