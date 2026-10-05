import type { DeployAppSummary, DeployNginxApplyResult, DeployProxyMode, DeployStreamEvent, DeployValidationIssue } from '@smt/shared';
import { api, ApiError } from '@/lib/api.js';
import { readSSE } from '@/lib/sse.js';
import { useAuthStore } from '@/store/auth.js';

/**
 * Server-side deployments in the browser (deployments spec §7). Everything
 * comes from `/api/deploy`, which reads the server on every request: the
 * page keeps nothing beyond React Query's cache, and refetches after each
 * action.
 */

/** API paths for one server's deployments. */
export const deployPath = (serverId: string, rest = '') => `/deploy/servers/${encodeURIComponent(serverId)}${rest}`;
export const appPath = (serverId: string, app: string, rest = '') => deployPath(serverId, `/apps/${encodeURIComponent(app)}${rest}`);

export const deployKeys = {
  all: (serverId: string) => ['deploy', serverId] as const,
  state: (serverId: string) => ['deploy', serverId, 'state'] as const,
  proxy: (serverId: string) => ['deploy', serverId, 'proxy'] as const,
  apps: (serverId: string) => ['deploy', serverId, 'apps'] as const,
  app: (serverId: string, app: string) => ['deploy', serverId, 'app', app] as const,
  releases: (serverId: string, app: string) => ['deploy', serverId, 'app', app, 'releases'] as const,
  config: (serverId: string, app: string) => ['deploy', serverId, 'app', app, 'config'] as const,
  env: (serverId: string, app: string) => ['deploy', serverId, 'app', app, 'env'] as const,
  domains: (serverId: string, app: string) => ['deploy', serverId, 'app', app, 'domains'] as const,
};

/**
 * A row of the app list: the summary with, when bastionctl reports them,
 * certificate status (spec §6) and the container's memory and CPU. Older
 * bastionctl versions leave them out, and the list shows a dash.
 */
export type DeployAppRow = DeployAppSummary;

/** The codes the deploy API answers with that the page acts on (server deploy/errors.ts). */
export function deployErrorCode(err: unknown): string | null {
  return err instanceof ApiError ? (err.code ?? null) : null;
}

/** Problems `PUT …/config` found (422 `invalid_config`), or null for any other failure. */
export function validationIssues(err: unknown): DeployValidationIssue[] | null {
  if (!(err instanceof ApiError) || err.code !== 'invalid_config') return null;
  const errors = err.details?.errors;
  return Array.isArray(errors) ? (errors as DeployValidationIssue[]) : [];
}

/** Issues for one field (`run.port`), including its items (`domains.1`). */
export function issuesAt(issues: DeployValidationIssue[] | null, path: string): DeployValidationIssue[] {
  return (issues ?? []).filter((i) => i.path === path || i.path.startsWith(`${path}.`));
}

/**
 * Upload a deploy source and follow the deploy's event stream. `fetch` cannot
 * report upload progress, so this uses XMLHttpRequest and reads the stream
 * from the growing response text. Resolves when the stream ends; rejects
 * with an ApiError when the server refused before streaming (409, 413…).
 */
export function uploadDeploy(
  path: string,
  source: Blob,
  filename: string,
  handlers: {
    onProgress: (loaded: number, total: number) => void;
    /** The upload is on the server; the deploy runs now. */
    onUploaded: () => void;
    onEvent: (event: DeployStreamEvent) => void;
  },
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', api.url(path));
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'text/event-stream');
    let seen = 0;
    let buffer = '';
    let uploaded = false;
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
        handlers.onEvent(JSON.parse(data) as DeployStreamEvent);
      } catch {
        // Not JSON: skipped, as readSSE does
      }
    };

    xhr.upload.onprogress = (e) => handlers.onProgress(e.loaded, e.lengthComputable ? e.total : source.size);
    xhr.upload.onload = () => handlers.onProgress(source.size, source.size);
    xhr.onreadystatechange = () => {
      if (xhr.readyState >= XMLHttpRequest.HEADERS_RECEIVED && !uploaded && streaming()) {
        uploaded = true;
        handlers.onUploaded();
      }
    };
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
      let details: Record<string, unknown> | undefined;
      try {
        const body = JSON.parse(xhr.responseText) as { error?: string; message?: string; code?: string };
        message = body.error ?? body.message ?? message;
        code = body.code;
        details = body as Record<string, unknown>;
      } catch {
        // Not JSON — the raw body is the best message we have
      }
      // As api.ts does for every other call: a lapsed session signs out
      if (xhr.status === 401) useAuthStore.getState().expireSession();
      reject(new ApiError(message, xhr.status, code, details));
    };
    xhr.onerror = () => reject(new Error('The connection to BastionSSH was lost'));
    xhr.onabort = () => resolve();
    signal.addEventListener('abort', () => xhr.abort(), { once: true });

    const form = new FormData();
    form.append('source', source, filename);
    xhr.send(form);
  });
}

/** POST a JSON body and follow the event stream it answers with (rollback). */
export async function followDeployStream(
  path: string,
  body: unknown,
  signal: AbortSignal,
  onEvent: (event: DeployStreamEvent) => void,
): Promise<void> {
  const res = await api.stream(path, body, { signal, headers: { Accept: 'text/event-stream' } });
  for await (const event of readSSE<DeployStreamEvent>(res)) {
    if (signal.aborted) return;
    onEvent(event);
  }
}

/**
 * In nginx mode, what the host's nginx helper did after a config save or a
 * delete (`proxy` in their answer): a toast when it needs attention.
 */
export function nginxSyncMessage(proxy: DeployNginxApplyResult | null | undefined): string | null {
  if (!proxy) return null;
  if (proxy.result === 'failed') return `The host's nginx was not updated: ${proxy.error ?? 'the nginx helper failed'}`;
  if (proxy.certificate === 'failed') return `nginx is updated, but no certificate could be obtained${proxy.error ? `: ${proxy.error}` : ''}. Check DNS under Domains.`;
  return null;
}

/** A starting `bastion.yml` for a new app, for the server's proxy mode. */
export function configTemplate(name: string, domain: string, proxy: DeployProxyMode = 'caddy'): string {
  return [
    `name: ${name}`,
    `domains: [${domain || `${name}.example.com`}]`,
    'redirect_www: none',
    'tls: auto',
    'build:',
    '  type: nextjs',
    'run:',
    '  port: 3000',
    'healthcheck: { path: /, timeout: 30s }',
    'keep_releases: 5',
    `proxy: ${proxy}`,
    '',
  ].join('\n');
}

/** `2026-10-05T12:00:00Z` → a short local date and time. */
export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
