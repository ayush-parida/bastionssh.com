import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { StorageFolderEstimate } from '@smt/shared';
import { CheckCircle2, FolderDown, Loader2, TriangleAlert, X } from 'lucide-react';
import { api } from '@/lib/api.js';
import { formatBytes } from '@/lib/utils.js';
import DocsLink from '@/components/docs/DocsLink.js';
import {
  STORAGE_FOLDER_DOCS,
  archiveName,
  browserCanPick,
  chooseMode,
  describeEstimate,
  downloadArchive,
  folderArchivePath,
  isAbortError,
  limitWarning,
  type ArchiveFormat,
} from '@/lib/storage-folder-download.js';

type Phase = 'ready' | 'downloading' | 'done' | 'failed';

const FORMATS: { value: ArchiveFormat; label: string; hint: string }[] = [
  { value: 'zip', label: '.zip', hint: 'Opens on macOS and Windows without extra software' },
  { value: 'tar.gz', label: '.tar.gz', hint: 'Usually smaller for text and logs' },
];

/**
 * Object Storage → Download folder: a quick count of what is under the
 * prefix, the format, then the archive with the bytes received so far and a
 * way to stop it. Closing the dialog cancels a download still running here.
 */
export default function FolderDownloadDialog({
  connectionId,
  bucket,
  base,
  prefix,
  onClose,
}: {
  connectionId: string;
  bucket: string;
  /** `/storage/connections/:id/buckets/:bucket` */
  base: string;
  /** `''` for the whole bucket. */
  prefix: string;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ArchiveFormat>('zip');
  const [phase, setPhase] = useState<Phase>('ready');
  const [received, setReceived] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [handedOver, setHandedOver] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const estimate = useQuery<StorageFolderEstimate>({
    queryKey: ['storage-folder-estimate', connectionId, bucket, prefix],
    queryFn: () => api.get(`${base}/folder/estimate?prefix=${encodeURIComponent(prefix)}`),
    retry: false,
    staleTime: 30_000,
  });

  const canPick = browserCanPick();
  const mode = chooseMode(estimate.data, canPick);
  const filename = archiveName(bucket, prefix, format);
  const warning = estimate.data ? limitWarning(estimate.data) : null;
  const busy = phase === 'downloading';
  const shown = prefix === '' ? bucket : prefix;

  async function start() {
    const controller = new AbortController();
    abort.current = controller;
    setPhase('downloading');
    setReceived(0);
    setError(null);
    try {
      const saved = await downloadArchive(folderArchivePath(base, prefix, format), filename, mode, {
        signal: controller.signal,
        onProgress: setReceived,
      });
      if (!saved) {
        setPhase('ready');
        return;
      }
      setHandedOver(mode === 'browser');
      setPhase('done');
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) {
        setPhase('ready');
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setPhase('failed');
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  }

  function cancel() {
    abort.current?.abort();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-download-title"
        className="border-border bg-card flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg border shadow-xl"
      >
        <div className="border-border flex items-center gap-3 border-b px-4 py-3">
          <FolderDown size={16} className="text-primary shrink-0" />
          <span id="folder-download-title" className="flex-1 truncate text-sm font-semibold">
            Download folder <span className="font-mono">{shown}</span>
          </span>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            title={busy ? 'Cancel the download' : 'Close'}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-4 text-sm">
          <p className="text-muted-foreground" aria-live="polite">
            {estimate.isLoading ? (
              <span className="flex items-center gap-1.5">
                <Loader2 size={13} className="animate-spin" /> Counting what is inside…
              </span>
            ) : estimate.isError ? (
              <span className="text-red-600">{(estimate.error as Error).message}</span>
            ) : estimate.data ? (
              <>
                {prefix === '' ? 'The whole bucket' : 'This folder'} holds {describeEstimate(estimate.data)}
                {estimate.data.files > 0 ? ', subfolders included.' : '.'}
              </>
            ) : null}
          </p>

          {warning && (
            <p role="alert" className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" />
              <span>{warning}</span>
            </p>
          )}

          <fieldset disabled={busy} className="space-y-1.5">
            <legend className="text-muted-foreground mb-1 text-xs">Format</legend>
            {FORMATS.map((f) => (
              <label key={f.value} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="folder-download-format"
                  value={f.value}
                  checked={format === f.value}
                  onChange={() => setFormat(f.value)}
                  className="mt-1"
                />
                <span>
                  <span className="font-mono">{f.label}</span>
                  <span className="text-muted-foreground block text-xs">{f.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {busy && (
            <div className="border-border bg-muted/30 space-y-2 rounded-md border p-3">
              <div className="flex items-center gap-2 text-xs">
                <span
                  className="bg-muted h-1.5 flex-1 overflow-hidden rounded"
                  role="progressbar"
                  aria-label="Download progress"
                  aria-valuetext={`${formatBytes(received, 1)} received`}
                >
                  <span className="bg-primary block h-full w-1/3 animate-pulse" />
                </span>
                <span className="text-muted-foreground w-32 text-right">{formatBytes(received, 1)} received</span>
              </div>
              <p className="text-muted-foreground text-xs">
                The archive is built while the objects stream down, so its final size is known only at the end.
              </p>
            </div>
          )}

          {phase === 'done' && (
            <p className="flex items-start gap-1.5 text-xs">
              <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-500" />
              <span>
                {handedOver
                  ? `${filename} is downloading in your browser — its downloads list shows the progress.`
                  : `Saved ${filename} (${formatBytes(received, 1)}). Anything left out is listed in _skipped.txt inside it.`}
              </span>
            </p>
          )}

          {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-red-600">{error}</p>}

          {mode === 'browser' && phase === 'ready' && !estimate.isLoading && (
            <p className="text-muted-foreground text-xs">
              This browser cannot save straight to a file from the page, so a large folder is handed to its downloads
              list, which shows the progress and can cancel it.
            </p>
          )}

          <div className="flex items-center justify-between gap-2">
            <DocsLink to={STORAGE_FOLDER_DOCS} className="text-xs">
              About folder downloads
            </DocsLink>
            <div className="flex gap-2">
              {busy ? (
                <button onClick={cancel} className="border-border hover:bg-muted rounded-md border px-3 py-2 text-sm">
                  Cancel download
                </button>
              ) : (
                <button onClick={onClose} className="border-border hover:bg-muted rounded-md border px-3 py-2 text-sm">
                  {phase === 'done' ? 'Close' : 'Cancel'}
                </button>
              )}
              <button
                onClick={() => void start()}
                disabled={busy || estimate.isError}
                className="bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <FolderDown size={14} />}
                {busy ? 'Downloading…' : phase === 'done' ? 'Download again' : 'Download'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
