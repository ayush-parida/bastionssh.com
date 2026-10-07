import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  dockerPlatform,
  type DockerComposeProject,
  type DockerComposeServiceImage,
  type DockerEngineInfo,
  type DockerImageLoadResult,
  type DockerPermissions,
  type DockerPullProgress,
} from '@smt/shared';
import { CheckCircle2, Copy, FileArchive, Lightbulb, Loader2, RefreshCw, TriangleAlert, Upload, X } from 'lucide-react';
import { api } from '@/lib/api.js';
import { cn, formatBytes } from '@/lib/utils.js';
import { dockerKeys, dockerPath, shortId } from '@/lib/docker.js';
import { removeUnusedImage } from '@/lib/docker-actions.js';
import {
  DOCKER_DOCS,
  archiveFileName,
  buildCommands,
  isArchiveName,
  manageableProjects,
  matchingServices,
  recallUpload,
  rememberUpload,
  uploadImage,
} from '@/lib/docker-upload.js';
import DocsLink from '@/components/docs/DocsLink.js';
import { ComposeOutput, composeCommandLine, useComposeRun } from './ComposeAction.js';

/** Default upload limit when the server does not say (older server): 5 GiB. */
const DEFAULT_MAX_BYTES = 5 * 1024 ** 3;

type Phase = 'pick' | 'uploading' | 'loading' | 'loaded' | 'failed';

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied');
  } catch {
    toast.message('Select the text to copy it');
  }
}

function CommandLine({ label, command }: { label: string; command: string }) {
  return (
    <div>
      <p className="mb-1 text-xs text-muted-foreground">{label}</p>
      <div className="flex items-start gap-2 rounded bg-zinc-950 px-3 py-2">
        <code className="flex-1 break-all font-mono text-xs leading-5 text-zinc-100">{command}</code>
        <button
          type="button"
          onClick={() => void copy(command)}
          aria-label={`Copy: ${label}`}
          title="Copy"
          className="shrink-0 text-zinc-400 hover:text-zinc-100"
        >
          <Copy size={13} />
        </button>
      </div>
    </div>
  );
}

/**
 * The "build and save" half of the deployment, done on your own machine:
 * the two commands, filled in from the image name, for this server's
 * platform as its engine reports it.
 */
function BuildInstructions({
  image,
  context,
  onImage,
  onContext,
  platform,
  open,
}: {
  image: string;
  context: string;
  onImage: (v: string) => void;
  onContext: (v: string) => void;
  platform: string | null;
  open: boolean;
}) {
  const commands = buildCommands({ image, context, platform: platform ?? 'linux/amd64' });
  const tag = image.trim() || 'my-app:latest';
  return (
    <details open={open} aria-label="How to build and save the image" className="rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-sm">
      <summary className="flex cursor-pointer items-center gap-1.5 font-medium">
        <Lightbulb size={14} className="text-sky-600 dark:text-sky-400" /> How to build and save the image
      </summary>
      <div className="mt-2 space-y-3">
        <p className="text-muted-foreground">On your own machine, in a terminal:</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Image name and tag</span>
            <input
              value={image}
              onChange={(e) => onImage(e.target.value)}
              placeholder="my-app:latest"
              aria-label="Image name"
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Build folder (with the Dockerfile)</span>
            <input
              value={context}
              onChange={(e) => onContext(e.target.value)}
              placeholder="."
              aria-label="Build folder"
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </label>
        </div>
        <CommandLine label="1. Build it for the server" command={commands.build} />
        <CommandLine label="2. Save it to a compressed file" command={commands.save} />
        <p className="text-xs text-muted-foreground">
          3. Upload <span className="font-mono">{archiveFileName(tag)}</span> below.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>
            {platform ? (
              <>
                This server is <span className="font-mono text-foreground">{platform}</span>, so build with{' '}
                <span className="font-mono">--platform {platform}</span>.
              </>
            ) : (
              <>Build for the server's platform with --platform (usually linux/amd64).</>
            )}{' '}
            Without it, a Mac with Apple silicon builds for arm64, and the container fails with “exec format error”.
          </li>
          <li>
            The Compose service's <span className="font-mono">image:</span> must be exactly this tag —{' '}
            <span className="font-mono text-foreground">image: {tag}</span> — and it needs no <span className="font-mono">build:</span>{' '}
            section.
          </li>
        </ul>
        <DocsLink to={DOCKER_DOCS.upload}>Full guide: deploy an image built on your machine</DocsLink>
      </div>
    </details>
  );
}

/**
 * Upload an image built elsewhere — what `docker save` writes — into this
 * server's Docker engine, then optionally put it into service: recreate the
 * Compose service that uses it (`up -d --no-deps`) and remove the image it
 * replaced if nothing uses that any more. The archive goes straight into the
 * engine; nothing is stored in between. What the dialog remembers (image
 * name, project, service) stays in this browser.
 */
export default function UploadImageDialog({
  serverId,
  info,
  permissions,
  maxBytes,
  onClose,
}: {
  serverId: string;
  info: DockerEngineInfo | undefined;
  permissions: DockerPermissions;
  maxBytes: number | undefined;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const memory = useMemo(() => recallUpload(serverId), [serverId]);
  const [image, setImage] = useState(memory.image ?? '');
  const [context, setContext] = useState(memory.context ?? '.');
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('pick');
  const [sent, setSent] = useState(0);
  const [lines, setLines] = useState<DockerPullProgress[]>([]);
  const [result, setResult] = useState<DockerImageLoadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const limit = maxBytes ?? DEFAULT_MAX_BYTES;
  const platform = info ? dockerPlatform(info.osType || 'linux', info.architecture) : null;

  // Closing during the upload cancels it (nothing is loaded)
  useEffect(() => () => abort.current?.abort(), []);

  const fileProblem = !file
    ? null
    : file.size > limit
      ? `This file is ${formatBytes(file.size, 1)}; this BastionSSH takes image archives up to ${formatBytes(limit, 1)}.`
      : !isArchiveName(file.name)
        ? 'Pick what docker save wrote: a .tar or .tar.gz file (also .tar.xz, .tar.zst, .tar.bz2).'
        : null;

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!file || fileProblem) return;
    const controller = new AbortController();
    abort.current = controller;
    setPhase('uploading');
    setSent(0);
    setLines([]);
    setResult(null);
    setError(null);
    rememberUpload(serverId, { ...(image.trim() && { image: image.trim() }), context: context.trim() || '.' });
    let finished = false;
    try {
      await uploadImage(
        serverId,
        file,
        file.name,
        {
          onProgress: (loaded, total) => {
            setSent(loaded);
            if (loaded >= total) setPhase((p) => (p === 'uploading' ? 'loading' : p));
          },
          onEvent: (event) => {
            if (event.type === 'uploaded') {
              // The server has every byte, whatever the browser's progress events said
              setSent(file.size);
              setPhase('loading');
            }
            else if (event.type === 'load') setLines((prev) => prev.concat(event.progress).slice(-200));
            else if (event.type === 'loaded') {
              finished = true;
              setResult(event.result);
              setPhase('loaded');
              const first = event.result.images.find((i) => i.ref)?.ref;
              if (first) {
                rememberUpload(serverId, { image: first });
                if (!image.trim()) setImage(first);
              }
            } else if (event.type === 'error') {
              finished = true;
              setError(event.error);
              setPhase('failed');
            }
          },
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (!finished) {
        setError('The connection ended before Docker said the image was loaded. Check the Images tab.');
        setPhase('failed');
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase('failed');
    } finally {
      qc.invalidateQueries({ queryKey: dockerKeys.images(serverId) });
      qc.invalidateQueries({ queryKey: dockerKeys.info(serverId) });
    }
  }

  const busy = phase === 'uploading' || phase === 'loading';
  const percent = file && file.size > 0 ? Math.min(100, Math.round((sent / file.size) * 100)) : 0;

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
        aria-labelledby="upload-image-title"
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Upload size={16} className="shrink-0 text-primary" />
          <span id="upload-image-title" className="flex-1 text-sm font-semibold">
            Upload image
          </span>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            title={phase === 'uploading' ? 'Cancel the upload' : 'Close'}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-4 text-sm">
          <p className="text-muted-foreground">
            Send an image you built on your own machine straight into this server's Docker — what{' '}
            <span className="font-mono">docker save</span> writes, gzipped or not. Nothing is stored on the way.
          </p>

          <BuildInstructions
            image={image}
            context={context}
            onImage={setImage}
            onContext={setContext}
            platform={platform}
            open={!memory.image}
          />

          <form onSubmit={(e) => void start(e)} className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">Image archive</span>
              <input
                type="file"
                accept=".tar,.gz,.tgz,.xz,.txz,.zst,.tzst,.bz2,.tbz,.tbz2"
                disabled={busy}
                aria-label="Image archive"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setPhase('pick');
                  setError(null);
                  setResult(null);
                }}
                className="block w-full text-xs file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-sm hover:file:bg-muted"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                {file ? (
                  <>
                    <FileArchive size={12} className="mr-1 inline" />
                    {file.name} · {formatBytes(file.size, 1)}
                  </>
                ) : (
                  `.tar or .tar.gz, up to ${formatBytes(limit, 1)}.`
                )}
              </span>
            </label>
            {fileProblem && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-400">{fileProblem}</p>}

            {(busy || phase === 'loaded' || lines.length > 0) && (
              <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                <div className="flex items-center gap-2 text-xs">
                  <span className="h-1.5 flex-1 overflow-hidden rounded bg-muted" role="progressbar" aria-label="Upload progress" aria-valuenow={percent}>
                    <span className="block h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
                  </span>
                  <span className="w-40 text-right text-muted-foreground">
                    {formatBytes(sent, 1)} of {formatBytes(file?.size ?? 0, 1)}
                  </span>
                </div>
                {phase === 'uploading' && <p className="text-xs text-muted-foreground">Uploading… closing this dialog cancels it.</p>}
                {phase === 'loading' && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 size={12} className="animate-spin" /> Uploaded. Docker is loading the image…
                  </p>
                )}
                {lines.length > 0 && (
                  <div className="max-h-28 overflow-auto font-mono text-xs leading-5">
                    {lines.map((l, i) => (
                      <div key={i} className="truncate">
                        {l.status}
                        {l.total ? <span className="text-muted-foreground"> {Math.round(((l.current ?? 0) / l.total) * 100)}%</span> : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {error && (
              <p className="rounded-md bg-red-500/10 px-3 py-2 text-red-600">
                {error}{' '}
                <DocsLink to={DOCKER_DOCS.uploadTroubleshooting} className="text-xs">
                  Troubleshooting
                </DocsLink>
              </p>
            )}

            {phase !== 'loaded' && (
              <div className="flex justify-end gap-2">
                <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">
                  {phase === 'uploading' ? 'Cancel upload' : 'Cancel'}
                </button>
                <button
                  type="submit"
                  disabled={busy || !file || !!fileProblem}
                  className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  {phase === 'uploading' ? 'Uploading…' : phase === 'loading' ? 'Loading…' : 'Upload'}
                </button>
              </div>
            )}
          </form>

          {result && <LoadedImages result={result} />}
          {result && result.images.some((i) => i.ref) && (
            <UpdateService serverId={serverId} result={result} permissions={permissions} remembered={memory} onClose={onClose} />
          )}
          {result && !result.images.some((i) => i.ref) && (
            <div className="flex justify-end">
              <button onClick={onClose} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LoadedImages({ result }: { result: DockerImageLoadResult }) {
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 font-medium">
        <CheckCircle2 size={14} className="text-emerald-500" /> Loaded {result.images.length === 1 ? 'one image' : `${result.images.length} images`}
      </p>
      <ul className="space-y-1 text-xs">
        {result.images.map((i) => (
          <li key={i.id + (i.ref ?? '')} className="flex flex-wrap items-center gap-x-2">
            <span className="font-mono font-medium">{i.ref ?? '<untagged>'}</span>
            <span className="font-mono text-muted-foreground">{shortId(i.id)}</span>
            <span className={cn('rounded px-1.5 py-0.5', i.platformMismatch ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400' : 'bg-muted text-muted-foreground')}>
              {i.os}/{i.architecture}
              {i.variant ? `/${i.variant}` : ''}
            </span>
            {i.replacedId && <span className="text-muted-foreground">replaces {shortId(i.replacedId)}</span>}
          </li>
        ))}
      </ul>
      {result.warnings.map((w) => (
        <p key={w} role="alert" className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>{w}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * The optional second step: recreate the Compose service that runs the
 * uploaded tag, so it starts on the new image, then clean up what it replaced.
 */
function UpdateService({
  serverId,
  result,
  permissions,
  remembered,
  onClose,
}: {
  serverId: string;
  result: DockerImageLoadResult;
  permissions: DockerPermissions;
  remembered: { project?: string; service?: string };
  onClose: () => void;
}) {
  const projects = useQuery<DockerComposeProject[]>({
    queryKey: [...dockerKeys.containers(serverId), 'compose'],
    queryFn: () => api.get(dockerPath(serverId, '/compose')),
  });
  const serviceImages = useQuery<DockerComposeServiceImage[]>({
    queryKey: [...dockerKeys.containers(serverId), 'compose', 'images'],
    queryFn: () => api.get(dockerPath(serverId, '/compose/service-images')),
  });
  const usable = useMemo(() => manageableProjects(projects.data ?? []), [projects.data]);
  const refs = useMemo(() => result.images.map((i) => i.ref).filter((r): r is string => !!r), [result]);
  const matches = useMemo(() => matchingServices(refs, serviceImages.data ?? []), [refs, serviceImages.data]);

  const [project, setProject] = useState('');
  const [service, setService] = useState('');
  const [cleanup, setCleanup] = useState(true);
  const [cleanupNote, setCleanupNote] = useState<string | null>(null);
  const action = useComposeRun(serverId);
  const chosen = usable.find((p) => p.name === project);
  const replaced = [...new Set(result.images.map((i) => i.replacedId).filter((id): id is string => !!id))];

  // Preselect: a service configured with a loaded tag, else what was used last time, else the first
  useEffect(() => {
    if (project || usable.length === 0 || !serviceImages.isFetched) return;
    const match = matches.find((m) => usable.some((p) => p.name === m.project));
    const last = usable.find((p) => p.name === remembered.project);
    const pick = match
      ? { project: match.project, service: match.service }
      : last
        ? { project: last.name, service: last.services.some((s) => s.name === remembered.service) ? remembered.service! : last.services[0]!.name }
        : { project: usable[0]!.name, service: usable[0]!.services[0]!.name };
    setProject(pick.project);
    setService(pick.service);
  }, [usable, matches, serviceImages.isFetched, project, remembered.project, remembered.service]);

  const configured = serviceImages.data?.find((s) => s.project === project && s.service === service)?.image ?? null;
  const tagMatches = configured ? matchingServices(refs, [{ project, service, image: configured }]).length > 0 : null;

  async function update() {
    if (!chosen || !service) return;
    rememberUpload(serverId, { project, service });
    setCleanupNote(null);
    const ok = await action.run(project, 'up', service);
    if (!ok) return;
    toast.success(`${service} is running the new image`);
    if (cleanup && permissions.remove && replaced.length > 0) {
      const notes: string[] = [];
      for (const id of replaced) {
        try {
          await removeUnusedImage(serverId, id);
          notes.push(`Removed the old image ${shortId(id)}.`);
        } catch (err) {
          notes.push(`${err instanceof Error ? err.message : String(err)} (${shortId(id)}).`);
        }
      }
      setCleanupNote(notes.join(' '));
    }
  }

  return (
    <section aria-label="Then update a Compose service" className="space-y-3 rounded-md border border-border p-3">
      <div>
        <p className="font-medium">Then update a Compose service</p>
        <p className="text-xs text-muted-foreground">
          Optional. Recreates the service on the new image with <span className="font-mono">docker compose up -d --no-deps</span>; the
          services next to it keep running.
        </p>
      </div>

      {projects.isLoading ? (
        <p className="text-xs text-muted-foreground">Looking for Compose projects…</p>
      ) : usable.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No Compose project on this server can be updated from here. Start your project once on the server (
          <span className="font-mono">docker compose up -d</span>) with the service's <span className="font-mono">image:</span> set to the
          tag you uploaded. <DocsLink to={DOCKER_DOCS.uploadSteps}>How</DocsLink>
        </p>
      ) : action.phase === 'confirm' ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">Project</span>
              <select
                value={project}
                aria-label="Project"
                onChange={(e) => {
                  setProject(e.target.value);
                  setService(usable.find((p) => p.name === e.target.value)?.services[0]?.name ?? '');
                }}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              >
                {usable.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">Service</span>
              <select
                value={service}
                aria-label="Service"
                onChange={(e) => setService(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              >
                {(chosen?.services ?? []).map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {configured && (
            <p className={cn('text-xs', tagMatches ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400')}>
              {tagMatches ? (
                <>
                  <CheckCircle2 size={12} className="mr-1 inline text-emerald-500" />
                  Its <span className="font-mono">image:</span> is <span className="font-mono">{configured}</span> — the tag you uploaded.
                </>
              ) : (
                <>
                  <TriangleAlert size={12} className="mr-1 inline" />
                  Its <span className="font-mono">image:</span> is <span className="font-mono">{configured}</span>, not {refs.join(', ')}: it would
                  keep running its old image. Change the tag in the compose file, or rebuild with the tag it uses.
                </>
              )}
            </p>
          )}
          {permissions.remove && replaced.length > 0 && (
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" checked={cleanup} onChange={(e) => setCleanup(e.target.checked)} className="mt-0.5" />
              <span>
                Remove the image this replaced ({replaced.map(shortId).join(', ')}) if nothing uses it
                <span className="block text-muted-foreground">Only an untagged image no container uses is removed; nothing else is touched.</span>
              </span>
            </label>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">
              Done
            </button>
            <button
              onClick={() => void update()}
              disabled={!chosen || !service}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <RefreshCw size={14} /> Update {service || 'service'}
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-col">
          <ComposeOutput
            command={composeCommandLine(project, 'up', service)}
            run={action}
            footer={
              <button
                onClick={onClose}
                disabled={action.phase === 'running'}
                className="ml-auto rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              >
                Close
              </button>
            }
          />
          {cleanupNote && <p className="mt-2 text-xs text-muted-foreground">{cleanupNote}</p>}
        </div>
      )}
    </section>
  );
}
