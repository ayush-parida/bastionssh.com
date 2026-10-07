import type { DockerComposeProject, DockerComposeServiceImage, DockerStreamEvent } from '@smt/shared';
import { api, ApiError } from '@/lib/api.js';
import { dockerPath } from '@/lib/docker.js';
import { useAuthStore } from '@/store/auth.js';

/**
 * Upload image (Docker tab): sending a `docker save` archive to a server's
 * engine, and the small pieces of logic around it — the build/save commands
 * shown in the dialog, which compose service an uploaded tag belongs to, and
 * what the dialog remembers per server in this browser (never on the server).
 */

/** The Docs pages the upload dialog and the Docker tab link to. */
export const DOCKER_DOCS = {
  upload: '/docs/docker/upload-image',
  uploadSteps: '/docs/docker/upload-image#step-by-step',
  uploadTroubleshooting: '/docs/docker/upload-image#troubleshooting',
  compose: '/docs/docker/compose-projects',
} as const;

/** Names the dialog takes: what `docker save` writes, plain or compressed. */
const ARCHIVE_NAME = /\.(tar|tar\.gz|tgz|tar\.xz|txz|tar\.zst|tzst|tar\.bz2|tbz2?)$/i;

export function isArchiveName(name: string): boolean {
  return ARCHIVE_NAME.test(name);
}

/** A reference to compare by: `docker.io/library/` dropped and `:latest` added when there is no tag or digest. */
export function normalizeImageRef(ref: string): string {
  let r = ref.trim();
  r = r.replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '');
  if (!r.includes('/') || /^library\/[^/]+$/.test(r)) r = r.replace(/^library\//, '');
  const last = r.slice(r.lastIndexOf('/') + 1);
  if (!last.includes(':') && !r.includes('@')) r = `${r}:latest`;
  return r;
}

/** `knexbi-website:latest` → `knexbi-website.tar.gz`; `ghcr.io/org/app:1.2` → `app-1.2.tar.gz`. */
export function archiveFileName(image: string): string {
  const ref = image.trim().split('@')[0] || 'image';
  const last = ref.slice(ref.lastIndexOf('/') + 1);
  const [name, tag] = last.split(':') as [string, string | undefined];
  const base = tag && tag !== 'latest' ? `${name}-${tag}` : name;
  return `${base.replace(/[^\w.-]+/g, '-') || 'image'}.tar.gz`;
}

/** What to run on your own machine, in order: build for the server's platform, then save and compress. */
export function buildCommands(opts: { image: string; context: string; platform: string }): { build: string; save: string } {
  const image = opts.image.trim() || 'my-app:latest';
  const context = opts.context.trim() || '.';
  return {
    build: `docker build --platform ${opts.platform} -t ${image} ${context}`,
    save: `docker save ${image} | gzip > ${archiveFileName(image)}`,
  };
}

/** Compose services whose configured `image:` is one of the loaded tags. */
export function matchingServices(loadedRefs: string[], services: DockerComposeServiceImage[]): DockerComposeServiceImage[] {
  const wanted = new Set(loadedRefs.map(normalizeImageRef));
  return services.filter((s) => s.image && wanted.has(normalizeImageRef(s.image)));
}

/** Projects actions can run on, with the services they have. */
export function manageableProjects(projects: DockerComposeProject[]): DockerComposeProject[] {
  return projects.filter((p) => !p.unmanageable && p.services.length > 0);
}

// ── Remembered per server, in this browser ───────────────────────────────────

export interface UploadMemory {
  /** The image name typed in the instructions (`knexbi-website:latest`). */
  image?: string;
  /** The build context directory typed in the instructions. */
  context?: string;
  project?: string;
  service?: string;
}

const memoryKey = (serverId: string) => `docker-upload:${serverId}`;

/** What the dialog remembered for this server; empty when nothing was, or storage is unavailable. */
export function recallUpload(serverId: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): UploadMemory {
  try {
    const raw = storage?.getItem(memoryKey(serverId));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: UploadMemory = {};
    for (const key of ['image', 'context', 'project', 'service'] as const) {
      const v = (parsed as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.length <= 512) out[key] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Merge `patch` into what is remembered for this server; silently nothing when storage is unavailable. */
export function rememberUpload(serverId: string, patch: UploadMemory, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(memoryKey(serverId), JSON.stringify({ ...recallUpload(serverId, storage), ...patch }));
  } catch {
    // private mode, quota: the choice lasts for this page only
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

// ── The upload ───────────────────────────────────────────────────────────────

/**
 * Upload an image archive and follow the load's event stream. `fetch` cannot
 * report upload progress, so this uses XMLHttpRequest and reads the stream
 * from the growing response text (as deploy uploads do). Resolves when the
 * stream ends; rejects with an ApiError when the server refused before
 * streaming (413 too large, 400 not an archive, 403, 429…). Aborting during
 * the upload cancels it — nothing is loaded.
 */
export function uploadImage(
  serverId: string,
  file: Blob,
  filename: string,
  handlers: {
    onProgress: (sent: number, total: number) => void;
    onEvent: (event: DockerStreamEvent) => void;
  },
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', api.url(dockerPath(serverId, `/images/load?name=${encodeURIComponent(filename)}`)));
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'text/event-stream');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    let seen = 0;
    let buffer = '';
    const streaming = () => xhr.status >= 200 && xhr.status < 300 && /event-stream/.test(xhr.getResponseHeader('Content-Type') ?? '');

    const drain = (final: boolean) => {
      buffer += xhr.responseText.slice(seen);
      seen = xhr.responseText.length;
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        emit(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
      if (final && buffer.trim()) emit(buffer);
    };
    const emit = (block: string) => {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
        .join('\n');
      if (!data) return;
      try {
        handlers.onEvent(JSON.parse(data) as DockerStreamEvent);
      } catch {
        // Not JSON: skipped, as readSSE does
      }
    };

    xhr.upload.onprogress = (e) => handlers.onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
    xhr.upload.onload = () => handlers.onProgress(file.size, file.size);
    xhr.onprogress = () => {
      if (streaming()) drain(false);
    };
    xhr.onload = () => {
      if (streaming()) {
        drain(true);
        return resolve();
      }
      let message = xhr.responseText || xhr.statusText || 'The upload failed';
      let code: string | undefined;
      try {
        const body = JSON.parse(xhr.responseText) as { error?: string; message?: string; code?: string };
        message = body.error ?? body.message ?? message;
        code = body.code;
      } catch {
        // Not JSON — the raw body is the best message we have
      }
      if (xhr.status === 401) useAuthStore.getState().expireSession();
      reject(new ApiError(message, xhr.status, code));
    };
    xhr.onerror = () =>
      reject(new Error('The connection to BastionSSH was lost during the upload. If a proxy sits in front of BastionSSH, check its upload size limit.'));
    xhr.onabort = () => resolve();
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
