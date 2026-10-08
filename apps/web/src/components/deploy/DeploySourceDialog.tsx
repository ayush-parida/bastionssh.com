import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DEPLOY_DOCS,
  isEmulatedBuild,
  type DeployAppConfig,
  type DeployBuilderStatus,
  type DeployBuildWhere,
  type DeployServerPlatform,
  type DeploySourceProblem,
} from '@smt/shared';
import { FileArchive, FolderUp, Info, Loader2, ShieldAlert, TriangleAlert, Upload, X } from 'lucide-react';
import { api } from '@/lib/api.js';
import { checkSource, EXCLUDED_DIRS, isTarball, packFolder, packZip, sourceEnvFiles } from '@/lib/archive.js';
import { builderKey, builderPath, deployKeys, deployPath } from '@/lib/deploy.js';
import { BUILD_TYPE_GUIDES } from '@/lib/deploy-help.js';
import { cn, formatBytes } from '@/lib/utils.js';
import DocsLink from '@/components/docs/DocsLink.js';
import type { DeployOptions } from './DeployRun.js';

type Picked = { kind: 'file'; file: File } | { kind: 'folder'; name: string; files: File[] };

export interface PackedUpload {
  blob: Blob;
  filename: string;
}

/** The builder's platform against the server's: emulated (slower), impossible without QEMU, or nothing to say. */
function PlatformNote({ builder, server }: { builder: DeployBuilderStatus | undefined; server: string | null }) {
  if (!builder?.platform || !server) return null;
  if (builder.platforms.length > 0 && !builder.platforms.includes(server)) {
    return (
      <p role="alert" className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600">
        <TriangleAlert size={14} className="mt-0.5 shrink-0" />
        <span>
          The server runs {server}, which the builder ({builder.platform}) cannot build for: install QEMU emulation on BastionSSH&apos;s host once (
          <code className="font-mono">docker run --privileged --rm tonistiigi/binfmt --install all</code>).{' '}
          <DocsLink to={`${DEPLOY_DOCS.bastionBuild}#another-cpu-architecture`}>How</DocsLink>
        </span>
      </p>
    );
  }
  if (!isEmulatedBuild(builder.platform, server)) return null;
  return (
    <p role="note" aria-label="Emulated build" className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
      <Info size={14} className="mt-0.5 shrink-0" />
      <span>
        The server runs {server} and the builder is {builder.platform}: the image is built under QEMU emulation, often several times slower than a
        native build (a large Next.js app can take 10 minutes or more). <DocsLink to={`${DEPLOY_DOCS.bastionBuild}#another-cpu-architecture`}>Why</DocsLink>
      </span>
    </p>
  );
}

/**
 * Pick what to deploy: a `.zip`, `.tar.gz`/`.tgz`/`.tar`, or a folder. A
 * tarball goes up as it is; a zip or folder is packed in the browser first
 * (lib/archive.ts), without node_modules, .next and .git — and checked
 * against the app's build settings first, so Next's `.next` folder picked
 * for a static site is refused here, with what to pick instead. The server
 * checks again (tarballs only there).
 *
 * Where it is built: on the server, or next to BastionSSH by its builder
 * (bastion-side builds spec), which ships only the image — preset from
 * `build.where`, changeable for this deploy. Environment files are left out
 * of the upload unless "Include environment files" is ticked, with a warning.
 */
export default function DeploySourceDialog({
  serverId,
  app,
  build,
  onDeploy,
  onClose,
}: {
  serverId: string;
  app: string;
  /** The app's build settings from bastion.yml; null when they could not be read (nothing is checked then). */
  build: DeployAppConfig['build'] | null;
  /** `label` names the source; `pack` turns it into the upload, run while the log panel shows "Packing"; `options` say where to build. */
  onDeploy: (label: string, pack: () => Promise<PackedUpload>, options: DeployOptions) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<DeploySourceProblem | null>(null);
  const [checking, setChecking] = useState(false);
  const [where, setWhere] = useState<DeployBuildWhere>(build?.where ?? 'server');
  const [includeEnvFiles, setIncludeEnvFiles] = useState(false);
  const [envFiles, setEnvFiles] = useState<string[]>([]);
  const folderInput = useRef<HTMLInputElement>(null);
  const guide = build ? BUILD_TYPE_GUIDES[build.type] : null;

  const builder = useQuery<DeployBuilderStatus>({ queryKey: builderKey, queryFn: () => api.get(builderPath), retry: false, staleTime: 30_000 });
  const noBuilder = builder.data ? !builder.data.configured || !builder.data.reachable : false;
  // The server's platform, for the note on emulation: read only when building here is chosen (it asks the server's Docker)
  const platform = useQuery<DeployServerPlatform>({
    queryKey: deployKeys.platform(serverId),
    queryFn: () => api.get(deployPath(serverId, '/platform')),
    enabled: where === 'bastion' && !!builder.data?.reachable,
    retry: false,
    staleTime: 5 * 60_000,
  });

  // Environment files in a folder or zip, named before anything is packed (a tarball's are left out by the server)
  useEffect(() => {
    setEnvFiles([]);
    if (!picked || (picked.kind === 'file' && isTarball(picked.file.name))) return;
    let stale = false;
    sourceEnvFiles(picked.kind === 'folder' ? { kind: 'folder', files: picked.files } : { kind: 'zip', file: picked.file })
      .then((found) => !stale && setEnvFiles(found))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [picked]);

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
    // The query says what was chosen; build.where applies when it matches anyway
    const options: DeployOptions = { ...(where !== (build?.where ?? 'server') && { where }), ...(includeEnvFiles && { includeEnvFiles }) };
    const pack = { includeEnvFiles };
    if (picked.kind === 'file' && isTarball(picked.file.name)) {
      const file = picked.file;
      onDeploy(file.name, async () => ({ blob: file, filename: file.name }), options);
    } else if (picked.kind === 'file') {
      const file = picked.file;
      onDeploy(file.name, async () => ({ blob: (await packZip(file, pack)).blob, filename: `${app}.tar.gz` }), options);
    } else {
      const files = picked.files;
      onDeploy(`${picked.name}/`, async () => ({ blob: (await packFolder(files, pack)).blob, filename: `${app}.tar.gz` }), options);
    }
    onClose();
  }

  const folderCount = picked?.kind === 'folder' ? picked.files.length : 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Deploy ${app}`}
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <p className="flex-1 text-lg font-semibold">
            Deploy <span className="font-mono">{app}</span>
          </p>
          <button onClick={onClose} title="Close" className="text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4 text-sm">
          <p className="text-muted-foreground">
            Upload the project source. It is built with the settings in <span className="font-mono">bastion.yml</span>, then the server starts the
            new release next to the current one and switches traffic once it is healthy.
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
            Folders and zips are packed here first, leaving out {EXCLUDED_DIRS.join(', ')} — dependencies are installed and the build runs again.
          </p>
          <fieldset aria-label="Where to build" className="space-y-1.5">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Build on</legend>
            {(
              [
                ['server', 'The server', 'npm install and the build run on the server, which needs the memory for them (a Next.js build wants 1–2 GB).'],
                ['bastion', 'BastionSSH', "Built by BastionSSH's builder for the server's platform; only the finished image goes to the server."],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2',
                  where === value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
                  value === 'bastion' && noBuilder && where !== 'bastion' && 'cursor-not-allowed opacity-60',
                )}
              >
                <input
                  type="radio"
                  name="where"
                  value={value}
                  checked={where === value}
                  disabled={value === 'bastion' && noBuilder && where !== 'bastion'}
                  onChange={() => setWhere(value)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">{label}</span>
                  {build?.where === value && <span className="ml-1.5 text-xs text-muted-foreground">(bastion.yml)</span>}
                  <span className="block text-xs text-muted-foreground">{hint}</span>
                </span>
              </label>
            ))}
            {noBuilder && (
              <p className="text-xs text-muted-foreground">
                {builder.data?.configured
                  ? `BastionSSH's builder is not reachable${builder.data.error ? `: ${builder.data.error}` : ''}.`
                  : 'This BastionSSH has no builder (SMT_BUILDKIT_ADDR is not set).'}{' '}
                <DocsLink to={DEPLOY_DOCS.bastionBuild}>Set it up</DocsLink>
              </p>
            )}
            {where === 'bastion' && <PlatformNote builder={builder.data} server={platform.data?.platform ?? null} />}
          </fieldset>
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={includeEnvFiles} onChange={(e) => setIncludeEnvFiles(e.target.checked)} />
              Include environment files
              <span className="text-xs text-muted-foreground">(.env, .env.local, …)</span>
            </label>
            {includeEnvFiles ? (
              <p role="alert" aria-label="Environment files included" className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                <span>
                  The upload&apos;s environment files{envFiles.length > 0 && <> ({envFiles.join(', ')})</>} go up with the source: their secrets are kept in
                  the release on the server and can end up in the image (<span className="font-mono">COPY . .</span>), where anyone who can pull it
                  reads them. Put runtime values in the app&apos;s .env on the server instead. <DocsLink to={`${DEPLOY_DOCS.bastionBuild}#environment-files`}>Why</DocsLink>
                </span>
              </p>
            ) : (
              envFiles.length > 0 && (
                <p data-testid="env-files-left-out" className="text-xs text-muted-foreground">
                  Left out of the upload: <span className="font-mono">{envFiles.join(', ')}</span>. Runtime values come from the app&apos;s .env on the
                  server; <span className="font-mono">NEXT_PUBLIC_*</span> and <span className="font-mono">build.args</span> reach the build from there.
                </p>
              )
            )}
          </div>
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
              disabled={!picked || checking || !!problem || (where === 'bastion' && noBuilder)}
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
