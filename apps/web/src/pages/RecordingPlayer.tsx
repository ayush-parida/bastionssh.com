import { useMemo, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionRecordingDetail } from '@smt/shared';
import { ArrowLeft, Download, Keyboard, Scissors, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { formatBytes } from '@/lib/utils.js';
import { isPasskeyCancel, passkeyErrorMessage, withStepUp } from '@/lib/passkeys.js';
import { useHasRole } from '@/store/auth.js';
import CastPlayer, { parseCast, playbackTime, type CastPlayerHandle } from '@/components/recordings/CastPlayer.js';
import { recordingDuration } from '@/pages/Recordings.js';

export default function RecordingPlayerPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isOwner = useHasRole('owner');
  const playerRef = useRef<CastPlayerHandle>(null);

  const { data: rec, error } = useQuery<SessionRecordingDetail>({
    queryKey: ['recordings', id],
    queryFn: () => api.get(`/recordings/${id}`),
    enabled: !!id,
  });

  // Each fetch is audited as a view, so fetch once per visit rather than on every focus
  const { data: castText, error: castError } = useQuery<string>({
    queryKey: ['recordings', id, 'cast'],
    queryFn: () => api.text(`/recordings/${id}/cast`),
    enabled: !!rec,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const cast = useMemo(() => {
    if (!castText) return null;
    try {
      return parseCast(castText);
    } catch {
      return null;
    }
  }, [castText]);

  const deleteMutation = useMutation({
    mutationFn: () => withStepUp(() => api.delete(`/recordings/${id}`)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recordings'] });
      toast.success('Recording deleted');
      navigate('/recordings');
    },
    onError: (err: Error) => {
      if (!isPasskeyCancel(err)) toast.error(passkeyErrorMessage(err, err.message));
    },
  });

  function download() {
    if (!rec) return;
    const name = `${(rec.serverName ?? 'session').replace(/[^\w.-]+/g, '_')}-${rec.startedAt.slice(0, 19).replace(/:/g, '-')}.cast`;
    api.download(`/recordings/${rec.id}/cast?download=1`, name).catch((err: Error) => toast.error(err.message));
  }

  if (error) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">
          This recording does not exist or you cannot view it.{' '}
          <Link to="/recordings" className="text-primary hover:underline">
            Back to recordings
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <button
        onClick={() => navigate('/recordings')}
        className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={14} /> Recordings
      </button>

      {rec && (
        <div className="mb-4 flex flex-wrap items-start gap-4">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold truncate">
              {rec.kind === 'exec' ? (
                <span className="font-mono">{rec.command}</span>
              ) : rec.kind === 'container' ? (
                <>
                  Shell in container <span className="font-mono">{rec.container?.name ?? rec.command}</span>
                  {rec.container && <span className="font-mono text-sm font-normal text-muted-foreground"> {rec.container.id}</span>}
                </>
              ) : (
                'Terminal session'
              )}
              <span className="text-muted-foreground font-normal"> · {rec.serverName ?? 'deleted server'}</span>
            </h1>
            <p className="text-sm text-muted-foreground">
              {rec.userEmail ?? rec.userId} · {new Date(rec.startedAt).toLocaleString()} · {recordingDuration(rec)} ·{' '}
              {formatBytes(rec.bytes, 1)}
              {rec.kind === 'exec' && ` · ${rec.source === 'ai' ? 'AI assistant' : 'saved command'}`}
            </p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {rec.inputRecorded && (
                <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-amber-600 dark:text-amber-400">
                  <Keyboard size={12} /> Keystrokes recorded
                </span>
              )}
              {rec.truncated && (
                <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-muted-foreground">
                  <Scissors size={12} /> Truncated at the size limit
                </span>
              )}
              {!rec.endedAt && (
                <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-2 py-0.5 text-red-500">
                  <span className="size-1.5 rounded-full bg-red-500 animate-pulse" /> Still recording — showing what has been captured so far
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={download} className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
              <Download size={14} /> Download .cast
            </button>
            {isOwner && rec.endedAt && (
              <button
                onClick={() => {
                  if (confirm('Delete this recording permanently?')) deleteMutation.mutate();
                }}
                disabled={deleteMutation.isPending}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-red-500 hover:bg-red-500/10 disabled:opacity-50"
              >
                <Trash2 size={14} /> Delete
              </button>
            )}
          </div>
        </div>
      )}

      {castError ? (
        <p className="text-sm text-red-500">{(castError as Error).message}</p>
      ) : castText && !cast ? (
        <p className="text-sm text-red-500">This recording could not be read.</p>
      ) : !cast ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <CastPlayer ref={playerRef} cast={cast} />
      )}

      {rec && rec.commands.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">Commands run over this session</h2>
          <div className="rounded-lg border border-border bg-card divide-y divide-border">
            {rec.commands.map((c) => (
              <button
                key={c.id}
                onClick={() => cast && playerRef.current?.seek(playbackTime(cast, c.at))}
                title="Jump to this point"
                className="flex w-full items-center gap-3 px-4 py-2 text-left text-xs hover:bg-muted/40"
              >
                <span className="w-14 shrink-0 font-mono text-muted-foreground tabular-nums">{c.at.toFixed(1)}s</span>
                <span className="flex-1 truncate font-mono">{c.command}</span>
                <span className="text-muted-foreground">{c.source === 'ai' ? 'AI' : 'saved command'}</span>
                {c.exitCode != null && (
                  <span className={c.exitCode === 0 ? 'text-green-600' : 'text-red-500'}>exit {c.exitCode}</span>
                )}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            These ran on a separate channel; their output is not part of the terminal playback.
          </p>
        </section>
      )}
    </div>
  );
}
