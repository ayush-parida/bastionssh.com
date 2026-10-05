import { useEffect, useRef, useState } from 'react';
import type { DeployAppConfig, DeploySourceProblem } from '@smt/shared';
import { FileArchive, FolderUp, Loader2, ShieldAlert, TriangleAlert, Upload, X } from 'lucide-react';
import { checkSource, EXCLUDED_DIRS, isTarball, packFolder, packZip } from '@/lib/archive.js';
import { BUILD_TYPE_GUIDES } from '@/lib/deploy-help.js';
import { formatBytes } from '@/lib/utils.js';
import DocsLink from '@/components/docs/DocsLink.js';

type Picked = { kind: 'file'; file: File } | { kind: 'folder'; name: string; files: File[] };

export interface PackedUpload {
  blob: Blob;
  filename: string;
}

/**
 * Pick what to deploy: a `.zip`, `.tar.gz`/`.tgz`/`.tar`, or a folder. A
 * tarball goes up as it is; a zip or folder is packed in the browser first
 * (lib/archive.ts), without node_modules, .next and .git — and checked
 * against the app's build settings first, so Next's `.next` folder picked
 * for a static site is refused here, with what to pick instead. The server
 * checks again (tarballs only there).
 */
export default function DeploySourceDialog({
  app,
  build,
  onDeploy,
  onClose,
}: {
  app: string;
  /** The app's build settings from bastion.yml; null when they could not be read (nothing is checked then). */
  build: DeployAppConfig['build'] | null;
  /** `label` names the source; `pack` turns it into the upload, run while the log panel shows "Packing". */
  onDeploy: (label: string, pack: () => Promise<PackedUpload>) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<DeploySourceProblem | null>(null);
  const [checking, setChecking] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const guide = build ? BUILD_TYPE_GUIDES[build.type] : null;

  // Look at what was picked before anything is packed or sent
  useEffect(() => {
    setProblem(null);
    if (!picked || !build || (picked.kind === 'file' && isTarball(picked.file.name))) return;
    let stale = false;
    setChecking(true);
    checkSource(picked.kind === 'folder' ? { kind: 'folder', files: picked.files } : { kind: 'zip', file: picked.file }, build)
      .then((found) => !stale && setProblem(found))
      .catch((err: unknown) => !stale && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !stale && setChecking(false));
    return () => {
      stale = true;
    };
  }, [picked, build]);

  // React does not know the non-standard attribute
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
  }, []);

  function pickFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!isTarball(file.name) && !/\.zip$/i.test(file.name)) {
      setError('Choose a .zip, .tar.gz, .tgz or .tar file, or a folder');
      return;
    }
    setPicked({ kind: 'file', file });
  }

  function pickFolder(list: FileList | null) {
    setError(null);
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    const name = files[0]!.webkitRelativePath.split('/')[0] || 'folder';
    setPicked({ kind: 'folder', name, files });
  }

  function start() {
    if (!picked) return;
    if (picked.kind === 'file' && isTarball(picked.file.name)) {
      const file = picked.file;
      onDeploy(file.name, async () => ({ blob: file, filename: file.name }));
    } else if (picked.kind === 'file') {
      const file = picked.file;
      onDeploy(file.name, async () => ({ blob: (await packZip(file)).blob, filename: `${app}.tar.gz` }));
    } else {
      const files = picked.files;
      onDeploy(`${picked.name}/`, async () => ({ blob: (await packFolder(files)).blob, filename: `${app}.tar.gz` }));
    }
    onClose();
  }

  const folderCount = picked?.kind === 'folder' ? picked.files.length : 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={`Deploy ${app}`} className="w-full max-w-lg rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <p className="flex-1 text-lg font-semibold">
            Deploy <span className="font-mono">{app}</span>
          </p>
          <button onClick={onClose} title="Close" className="text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-4 px-5 py-4 text-sm">
          <p className="text-muted-foreground">
            Upload the project source. The server builds it with the settings in <span className="font-mono">bastion.yml</span>, starts the new
            release next to the current one, and switches traffic once it is healthy.
          </p>
          <p role="note" className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <ShieldAlert size={14} className="mt-0.5 shrink-0" />
            <span>
              Deploying runs this code on the server with <span className="font-mono">{app}</span>&apos;s secrets: the new release starts with every
              value in the app&apos;s .env and its volumes. Deploy only code you trust.
            </span>
          </p>
          {guide && (
            <p className="text-xs text-muted-foreground" data-testid="deploy-hint">
              {guide.hint} <DocsLink to={guide.docs}>How to deploy</DocsLink>
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed border-border p-4 text-center hover:bg-muted/50">
              <FileArchive size={20} className="text-muted-foreground" />
              <span className="font-medium">Archive</span>
              <span className="text-xs text-muted-foreground">.zip, .tar.gz, .tgz or .tar</span>
              <input
                type="file"
                aria-label="Archive file"
                accept=".zip,.tar,.tgz,.gz,application/zip,application/gzip,application/x-tar"
                className="sr-only"
                onChange={(e) => pickFile(e.target.files?.[0])}
              />
            </label>
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed border-border p-4 text-center hover:bg-muted/50">
              <FolderUp size={20} className="text-muted-foreground" />
              <span className="font-medium">Folder</span>
              <span className="text-xs text-muted-foreground">The project root</span>
              <input ref={folderInput} type="file" multiple aria-label="Project folder" className="sr-only" onChange={(e) => pickFolder(e.target.files)} />
            </label>
          </div>
          {picked && (
            <p className="rounded-md bg-muted px-3 py-2 text-xs">
              {picked.kind === 'file' ? (
                <>
                  <span className="font-mono">{picked.file.name}</span> · {formatBytes(picked.file.size)}
                </>
              ) : (
                <>
                  <span className="font-mono">{picked.name}/</span> · {folderCount} file{folderCount === 1 ? '' : 's'}
                </>
              )}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Folders and zips are packed here first, leaving out {EXCLUDED_DIRS.join(', ')} — the server installs dependencies and builds again.
          </p>
          {checking && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" /> Checking the files…
            </p>
          )}
          {problem && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-600">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
              <span>
                {problem.message} <DocsLink to={problem.docs}>Read how to fix it</DocsLink>
              </span>
            </div>
          )}
          {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
              Cancel
            </button>
            <button
              onClick={start}
              disabled={!picked || checking || !!problem}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              <Upload size={14} /> Deploy
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
