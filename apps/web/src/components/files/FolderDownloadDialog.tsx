import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, FolderDown, Loader2, TriangleAlert, X } from 'lucide-react';
import { api } from '@/lib/api.js';
import { cn, formatBytes } from '@/lib/utils.js';
import {
  FOLDER_ARCHIVE_FORMATS,
  archiveFileName,
  canStreamToDisk,
  chooseSaveTarget,
  downloadFolderArchive,
  type FolderArchiveFormat,
} from '@/lib/folder-download.js';
import DocsLink from '@/components/docs/DocsLink.js';

const FORMAT_KEY = 'smt.folderDownload.format';

function rememberedFormat(): FolderArchiveFormat {
  try {
    return localStorage.getItem(FORMAT_KEY) === 'tar.gz' ? 'tar.gz' : 'zip';
  } catch {
    return 'zip';
  }
}

type Phase = { kind: 'choose' } | { kind: 'running' } | { kind: 'done'; bytes: number } | { kind: 'failed'; message: string };

/**
 * "Download folder": pick zip or tar.gz, then watch the archive arrive
 * (bytes so far — the total is not known while the server builds it) with a
 * way to cancel, which also stops the work on the server.
 */
export default function FolderDownloadDialog({
  folderName,
  folderPath,
  apiPath,
  note,
  docsTo,
  onClose,
}: {
  folderName: string;
  /** Shown to the user. */
  folderPath: string;
  /** The API path for one format, e.g. `/sftp/<id>/folder?path=…&format=zip`. */
  apiPath: (format: FolderArchiveFormat) => string;
  /** Viewer-specific advice under the format choice. */
  note?: ReactNode;
  docsTo?: string;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<FolderArchiveFormat>(rememberedFormat);
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const [received, setReceived] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const controller = useRef<AbortController | null>(null);
  const running = phase.kind === 'running';
  const filename = archiveFileName(folderName, format);

  // Closing the page (or the dialog) mid-download cancels it
  useEffect(() => () => controller.current?.abort(), []);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);

  async function start() {
    try {
      localStorage.setItem(FORMAT_KEY, format);
    } catch {
      // Remembering the choice is a convenience only
    }
    let target;
    try {
      target = await chooseSaveTarget(filename);
    } catch (err) {
      setPhase({ kind: 'failed', message: err instanceof Error ? err.message : 'Could not open the file to save to' });
      return;
    }
    if (!target) return;
    const abort = new AbortController();
    controller.current = abort;
    setReceived(0);
    setStartedAt(Date.now());
    setNow(Date.now());
    setPhase({ kind: 'running' });
    try {
      const { bytes } = await downloadFolderArchive(apiPath(format), target, {
        signal: abort.signal,
        onProgress: setReceived,
      });
      setPhase({ kind: 'done', bytes });
    } catch (err) {
      if (abort.signal.aborted) setPhase({ kind: 'choose' });
      else setPhase({ kind: 'failed', message: err instanceof Error ? err.message : 'Download failed' });
    } finally {
      controller.current = null;
    }
  }

  function cancel() {
    controller.current?.abort();
  }

  const seconds = Math.max(1, (now - startedAt) / 1000);

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
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-download-title"
        className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <FolderDown size={16} className="shrink-0 text-primary" />
          <h2 id="folder-download-title" className="flex-1 truncate font-medium">
            Download folder
          </h2>
          <button
            onClick={onClose}
            disabled={running}
            title="Close"
            aria-label="Close"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4 text-sm">
          <p className="break-all font-mono text-xs text-muted-foreground">{folderPath}</p>

          <fieldset disabled={running} className="space-y-2">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Format</legend>
            {FOLDER_ARCHIVE_FORMATS.map((f) => (
              <label
                key={f.value}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2',
                  format === f.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
                )}
              >
                <input
                  type="radio"
                  name="folder-format"
                  value={f.value}
                  checked={format === f.value}
                  onChange={() => setFormat(f.value)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-mono font-medium">{f.label}</span>
                  <span className="block text-xs text-muted-foreground">{f.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {note && <div className="text-xs text-muted-foreground">{note}</div>}

          {running && (
            <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
              <Loader2 size={14} className="animate-spin text-primary" />
              <span>
                <span className="font-medium" data-testid="folder-download-received">
                  {formatBytes(received)}
                </span>{' '}
                received · {formatBytes(received / seconds)}/s
              </span>
            </div>
          )}

          {phase.kind === 'done' && (
            <div role="status" className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
              <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" />
              <span>
                Saved <span className="font-mono">{filename}</span> ({formatBytes(phase.bytes)}). Files that could not be read are
                listed in <span className="font-mono">_skipped.txt</span> inside it; a <span className="font-mono">_TRUNCATED.txt</span>{' '}
                means a size or file-count limit was reached.
              </span>
            </div>
          )}

          {phase.kind === 'failed' && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-red-600 dark:text-red-400">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
              <span>{phase.message}</span>
            </div>
          )}

          {!canStreamToDisk() && !running && (
            <p className="text-xs text-muted-foreground">
              This browser holds the archive in memory until it is complete. For a very large folder,{' '}
              <a href={api.url(apiPath(format))} download={filename} className="text-primary hover:underline">
                let the browser download it directly
              </a>{' '}
              (its own download list shows the progress).
            </p>
          )}

          {docsTo && <DocsLink to={docsTo}>About folder downloads</DocsLink>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          {running ? (
            <button
              onClick={cancel}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Cancel download
            </button>
          ) : (
            <>
              <button onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
                Close
              </button>
              <button
                onClick={() => void start()}
                className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                <FolderDown size={14} /> {phase.kind === 'done' || phase.kind === 'failed' ? 'Download again' : 'Download'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
