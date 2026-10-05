import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DeployProxyMode, DeployProxyState, DeployServerState, DeploySetupResult } from '@smt/shared';
import { CheckCircle2, Circle, Loader2, ShieldAlert, TriangleAlert, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { deployErrorCode, deployKeys, deployPath } from '@/lib/deploy.js';
import { cn } from '@/lib/utils.js';
import { deployLogHint } from '@/lib/deploy-help.js';
import DocsLink from '@/components/docs/DocsLink.js';
import { DEPLOY_DOCS } from '@smt/shared';

export type SetupAnswer = DeploySetupResult & { sudo: boolean; socket: 'writable' | 'sudo' | 'denied' | 'missing' };

function Requirement({ ok, label, hint }: { ok: boolean | null; label: string; hint?: string }) {
  return (
    <li className="flex items-start gap-2">
      {ok === null ? (
        <Circle size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
      ) : ok ? (
        <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-500" />
      ) : (
        <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-500" />
      )}
      <span>
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </li>
  );
}

function SetupErrorHint({ message }: { message: string }) {
  const hint = deployLogHint(message);
  if (!hint) return null;
  return (
    <span className="mt-1 block">
      <DocsLink to={hint.href}>How to fix: {hint.label}</DocsLink>
    </span>
  );
}

/** What an administrator still runs once on the server for nginx mode (spec §6). */
function NginxSteps({ proxy }: { proxy: DeployProxyState }) {
  if (proxy.instructions.length === 0) return null;
  return (
    <div aria-label="nginx setup steps" className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
      <p className="font-medium text-foreground">
        nginx mode needs these commands run once on the server, as an administrator (then deploy, or use Apply nginx again under Domains):
      </p>
      <ol className="list-decimal space-y-1 pl-5">
        {proxy.instructions.map((step) => (
          <li key={step}>
            <code className="block whitespace-pre-wrap break-all rounded bg-muted px-1.5 py-0.5 font-mono">{step}</code>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Deployments on this server: where they live, whether its bastionctl is the
 * one this BastionSSH ships, and Set up / Reinstall (spec §7). Setting up
 * creates the root folder (with sudo when the SSH user may), installs
 * bastionctl, the `bastion-apps` network and the proxy; it is safe to run
 * again. Prerequisites are checked by the server during setup; their state
 * shows after one has run, as nothing about the server is kept here. The
 * proxy mode is read from the server (`GET …/proxy`); a first setup picks
 * nginx when the host's nginx owns ports 80/443, or the mode chosen here.
 * Reinstalling keeps the mode the server has.
 */
export default function SetupPanel({
  serverId,
  state,
  proxy: proxyState,
  canManage,
  compact,
}: {
  serverId: string;
  state: DeployServerState;
  /** The proxy mode and nginx state; null while unknown (or from a server that cannot say). */
  proxy: DeployProxyState | null;
  canManage: boolean;
  /** A set-up server: one line, with Reinstall. */
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const [result, setResult] = useState<SetupAnswer | null>(null);
  const [choice, setChoice] = useState<DeployProxyMode | 'auto'>('auto');
  const setup = useMutation({
    // Reinstall (or no choice): the server keeps its mode, or detects one
    mutationFn: () => api.post<SetupAnswer>(deployPath(serverId, '/setup'), choice === 'auto' || compact ? undefined : { proxy: choice }),
    onSuccess: (res) => {
      setResult(res);
      toast.success(state.integrity === 'ok' ? 'bastionctl reinstalled' : 'Deployments are set up');
      qc.invalidateQueries({ queryKey: deployKeys.all(serverId) });
    },
  });
  const code = deployErrorCode(setup.error);
  const proxy = result?.proxy ?? proxyState?.mode ?? null;
  const nginxDetected = !proxyState?.mode && proxyState?.nginx.detected;

  const button = canManage && (
    <button
      onClick={() => setup.mutate()}
      disabled={setup.isPending}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50',
        compact ? 'border border-border hover:bg-muted' : 'bg-primary text-primary-foreground hover:opacity-90',
      )}
    >
      {setup.isPending ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
      {state.integrity === 'ok' ? 'Reinstall' : state.integrity === 'mismatch' ? 'Reinstall bastionctl' : 'Set up deployments'}
    </button>
  );

  if (compact && state.integrity === 'ok' && !setup.error) {
    return (
      <div className="mb-4 space-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-card px-4 py-2.5 text-sm">
          <span className="flex items-center gap-1.5">
            <CheckCircle2 size={14} className="text-emerald-500" /> Set up
          </span>
          <span className="text-muted-foreground">
            Root <span className="font-mono text-foreground">{state.root}</span>
          </span>
          <span className="text-muted-foreground">
            Proxy <span className="text-foreground">{proxy === 'nginx' ? 'nginx on the host' : (proxy ?? 'caddy')}</span>
          </span>
          <span className="text-muted-foreground">
            bastionctl <span className="font-mono text-foreground">{state.version}</span>
          </span>
          <DocsLink to={`${DEPLOY_DOCS.overview}#reinstall`} className="ml-auto text-xs">
            When to reinstall
          </DocsLink>
          <span>{button}</span>
        </div>
        {proxyState?.mode === 'nginx' && <NginxSteps proxy={proxyState} />}
      </div>
    );
  }

  return (
    <section aria-label="Setup" className="mb-4 space-y-4 rounded-lg border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">
            {state.integrity === 'mismatch' ? 'bastionctl needs reinstalling' : state.integrity === 'ok' ? 'Setup' : 'Set up deployments'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {state.integrity === 'mismatch'
              ? 'The bastionctl installed on this server is not the one this BastionSSH ships (another version, or the file was changed). Nothing runs until it is reinstalled.'
              : 'Apps, their config, secrets and releases live on the server, in one folder. BastionSSH installs bastionctl there and runs it over SSH; it stores nothing about your apps.'}{' '}
            <DocsLink to={state.integrity === 'mismatch' ? `${DEPLOY_DOCS.overview}#reinstall` : `${DEPLOY_DOCS.overview}#setup`}>
              {state.integrity === 'mismatch' ? 'When and why to reinstall' : 'Setup guide'}
            </DocsLink>
          </p>
        </div>
        {button}
      </div>

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Root folder</dt>
          <dd className="font-mono">{result?.root ?? state.root ?? '/opt/bastion, or ~/bastion'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Proxy</dt>
          <dd>
            {proxy === 'nginx'
              ? 'nginx on the host'
              : proxy === 'caddy'
                ? 'Caddy (bastion-caddy, ports 80 and 443)'
                : nginxDetected
                  ? 'nginx on the host (detected on ports 80/443)'
                  : 'Caddy (bastion-caddy, ports 80 and 443)'}
          </dd>
          {canManage && !proxyState?.mode && !result && (
            <label className="mt-1 block text-xs text-muted-foreground">
              <span className="sr-only">Proxy mode</span>
              <select
                aria-label="Proxy mode"
                value={choice}
                onChange={(e) => setChoice(e.target.value as DeployProxyMode | 'auto')}
                className="rounded-md border border-input bg-background px-1.5 py-0.5 text-xs"
              >
                <option value="auto">Automatic</option>
                <option value="caddy">Caddy</option>
                <option value="nginx">nginx on the host</option>
              </select>
            </label>
          )}
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">bastionctl</dt>
          <dd className="font-mono">{state.version}</dd>
        </div>
      </dl>

      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Prerequisites</p>
        <ul className="space-y-1.5 text-sm">
          <Requirement
            ok={result ? true : code === 'docker_missing' ? false : null}
            label="Docker Engine installed and running"
            hint="Nothing else is needed on the server: bastionctl runs in a pinned node:22-alpine container."
          />
          <Requirement
            ok={result ? result.socket !== 'denied' : code === 'docker_denied' ? false : null}
            label={result?.socket === 'sudo' ? 'The SSH user uses Docker through passwordless sudo' : 'The SSH user can use Docker'}
            hint="In the docker group, or allowed passwordless sudo for docker."
          />
          <Requirement
            ok={result ? (result.proxyContainer?.state === 'running') : null}
            label={(result?.proxy ?? proxy) === 'nginx' ? 'A loopback port free for bastion-caddy behind the host’s nginx' : 'Ports 80 and 443 free for the proxy'}
            hint={result?.proxyContainer ? `bastion-caddy: ${result.proxyContainer.status}` : undefined}
          />
          <Requirement
            ok={result ? true : null}
            label={result?.sudo ? `${result.root} created with sudo` : '/opt/bastion writable, or $HOME/bastion used instead'}
          />
        </ul>
      </div>

      {proxyState && (result?.proxy ?? proxyState.mode) === 'nginx' && <NginxSteps proxy={proxyState} />}
      {setup.error && (
        <p className="whitespace-pre-wrap break-words rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">
          {(setup.error as Error).message}
          <SetupErrorHint message={(setup.error as Error).message} />
        </p>
      )}
      {result && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          Network <span className="font-mono">{result.network}</span> and proxy ready in <span className="font-mono">{result.root}</span>.
        </p>
      )}
      <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
        <ShieldAlert size={14} className="mt-0.5 shrink-0 text-amber-500" />
        bastionctl and the proxy use the Docker socket, which is root-equivalent on the server — the same access Docker management already has.
      </p>
      {!canManage && state.integrity !== 'ok' && (
        <p className="text-sm text-muted-foreground">Setting up needs manage access to Deployments on this server.</p>
      )}
    </section>
  );
}
