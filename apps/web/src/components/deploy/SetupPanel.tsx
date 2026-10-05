import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DeployServerState, DeploySetupResult } from '@smt/shared';
import { CheckCircle2, Circle, Loader2, ShieldAlert, TriangleAlert, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { deployErrorCode, deployKeys, deployPath } from '@/lib/deploy.js';
import { cn } from '@/lib/utils.js';

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

/**
 * Deployments on this server: where they live, whether its bastionctl is the
 * one this BastionSSH ships, and Set up / Reinstall (spec §7). Setting up
 * creates the root folder (with sudo when the SSH user may), installs
 * bastionctl, the `bastion-apps` network and the proxy; it is safe to run
 * again. Prerequisites are checked by the server during setup; their state
 * shows after one has run, as nothing about the server is kept here.
 */
export default function SetupPanel({
  serverId,
  state,
  canManage,
  compact,
}: {
  serverId: string;
  state: DeployServerState;
  canManage: boolean;
  /** A set-up server: one line, with Reinstall. */
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const [result, setResult] = useState<SetupAnswer | null>(null);
  const setup = useMutation({
    mutationFn: () => api.post<SetupAnswer>(deployPath(serverId, '/setup')),
    onSuccess: (res) => {
      setResult(res);
      toast.success(state.integrity === 'ok' ? 'bastionctl reinstalled' : 'Deployments are set up');
      qc.invalidateQueries({ queryKey: deployKeys.all(serverId) });
    },
  });
  const code = deployErrorCode(setup.error);
  const proxy = result?.proxy ?? 'caddy';

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
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-card px-4 py-2.5 text-sm">
        <span className="flex items-center gap-1.5">
          <CheckCircle2 size={14} className="text-emerald-500" /> Set up
        </span>
        <span className="text-muted-foreground">
          Root <span className="font-mono text-foreground">{state.root}</span>
        </span>
        <span className="text-muted-foreground">
          Proxy <span className="text-foreground">{proxy}</span>
        </span>
        <span className="text-muted-foreground">
          bastionctl <span className="font-mono text-foreground">{state.version}</span>
        </span>
        <span className="ml-auto">{button}</span>
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
              : 'Apps, their config, secrets and releases live on the server, in one folder. BastionSSH installs bastionctl there and runs it over SSH; it stores nothing about your apps.'}
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
          <dd>{proxy === 'caddy' ? 'Caddy (bastion-caddy, ports 80 and 443)' : 'nginx on the host'}</dd>
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
            label="Ports 80 and 443 free for the proxy"
            hint={result?.proxyContainer ? `bastion-caddy: ${result.proxyContainer.status}` : undefined}
          />
          <Requirement
            ok={result ? true : null}
            label={result?.sudo ? `${result.root} created with sudo` : '/opt/bastion writable, or $HOME/bastion used instead'}
          />
        </ul>
      </div>

      {setup.error && (
        <p className="whitespace-pre-wrap break-words rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(setup.error as Error).message}</p>
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
