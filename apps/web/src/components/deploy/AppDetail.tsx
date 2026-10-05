import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deployPermissionLevel, type DeployAppStatus, type DeployNginxApplyResult, type DeployProxyMode, type DockerServerStatus } from '@smt/shared';
import { ArrowLeft, Lock, Power, RefreshCw, RotateCw, ShieldAlert, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { appPath, deployKeys, nginxSyncMessage, when } from '@/lib/deploy.js';
import { dockerKeys, dockerPath } from '@/lib/docker.js';
import { cn } from '@/lib/utils.js';
import ConfirmDialog from '@/components/docker/ConfirmDialog.js';
import ContainerLogs from '@/components/docker/ContainerLogs.js';
import ContainerStats from '@/components/docker/ContainerStats.js';
import { HealthBadge } from './AppList.js';
import ConfigEditor from './ConfigEditor.js';
import { DeployRunPanel, useDeployRun } from './DeployRun.js';
import DeploySourceDialog from './DeploySourceDialog.js';
import DomainsPanel from './DomainsPanel.js';
import EnvEditor from './EnvEditor.js';
import ReleasesPanel from './ReleasesPanel.js';

type Tab = 'overview' | 'releases' | 'config' | 'env' | 'domains';

export interface DeployLevels {
  operate: boolean;
  manage: boolean;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/**
 * Live usage and logs of the app's container, through the Docker module
 * (spec §5 `logs`): shown when Docker is on for the server and the member
 * may inspect containers there.
 */
function Runtime({ serverId, containerId, running }: { serverId: string; containerId: string; running: boolean }) {
  const [view, setView] = useState<'stats' | 'logs'>('stats');
  const docker = useQuery<DockerServerStatus>({
    queryKey: dockerKeys.status(serverId),
    queryFn: () => api.get(dockerPath(serverId)),
    retry: false,
    staleTime: 30_000,
  });
  if (!docker.data || docker.data.docker.mode !== 'auto' || !docker.data.permissions.inspect) return null;
  return (
    <section aria-label="Runtime" className="space-y-3">
      <div className="flex items-center gap-1 border-b border-border">
        {(['stats', 'logs'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={cn('border-b-2 px-3 py-1.5 text-sm', view === v ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {v === 'stats' ? 'Memory and CPU' : 'Live log'}
          </button>
        ))}
      </div>
      {view === 'stats' ? (
        running ? (
          <ContainerStats serverId={serverId} containerId={containerId} />
        ) : (
          <p className="text-sm text-muted-foreground">The container is not running.</p>
        )
      ) : (
        <ContainerLogs serverId={serverId} containerId={containerId} name={containerId} />
      )}
    </section>
  );
}

/**
 * One app (spec §7): its status, Deploy with a live log, Releases with
 * Rollback, Restart and Stop, bastion.yml, .env, Domains and Delete. Each
 * part reads the server when it opens; actions refetch what they change.
 */
export default function AppDetail({
  serverId,
  app,
  proxyMode,
  levels,
  onBack,
}: {
  serverId: string;
  app: string;
  /** The server's proxy mode (Domains). */
  proxyMode: DeployProxyMode;
  levels: DeployLevels;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('overview');
  const [dialog, setDialog] = useState<'deploy' | 'restart' | 'stop' | 'delete' | null>(null);
  const run = useDeployRun(serverId, app);

  const status = useQuery<DeployAppStatus>({
    queryKey: deployKeys.app(serverId, app),
    queryFn: () => api.get(appPath(serverId, app)),
    retry: false,
    // A deploy started elsewhere holds the lock: check back while it does
    refetchInterval: (q) => (q.state.data?.locked ? 5_000 : false),
  });

  const back = (
    <button onClick={onBack} className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
      <ArrowLeft size={14} /> All apps
    </button>
  );
  if (status.isLoading) return <div>{back}<p className="text-sm text-muted-foreground">Loading {app}…</p></div>;
  if (status.error || !status.data) {
    return (
      <div>
        {back}
        <p className="text-sm text-red-600">{status.error ? (status.error as Error).message : 'Not found'}</p>
      </div>
    );
  }
  const s = status.data;
  // bastion.yml's permissions.deploy: deploy and rollback may need manage rather than operate (the server enforces it)
  const deployLevel = deployPermissionLevel(s);
  const canDeploy = levels.operate && (deployLevel === 'operate' || levels.manage);
  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'releases', label: 'Releases' },
    { id: 'config', label: 'Config' },
    ...(levels.manage ? [{ id: 'env' as Tab, label: 'Environment' }] : []),
    { id: 'domains', label: 'Domains' },
  ];
  const action = async (verb: 'restart' | 'stop') => {
    await api.post(appPath(serverId, app, `/${verb}`));
    toast.success(verb === 'restart' ? `${app} restarted` : `${app} stopped`);
    await qc.invalidateQueries({ queryKey: deployKeys.all(serverId) });
  };

  return (
    <div>
      {back}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="font-mono text-xl font-bold">{app}</h2>
        <HealthBadge app={s} />
        {s.locked && (
          <span className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600" title={s.lock ? `${s.lock.holder} since ${when(s.lock.since)}` : undefined}>
            <Lock size={11} /> Deploy running
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            onClick={() => void status.refetch()}
            title="Refresh"
            className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RefreshCw size={14} className={status.isFetching ? 'animate-spin' : undefined} />
          </button>
          {levels.operate && (
            <>
              <button
                onClick={() => setDialog('deploy')}
                disabled={run.busy || !!s.configError || !canDeploy}
                title={s.configError ? 'Fix bastion.yml first' : !canDeploy ? 'Deploying this app needs manage access (bastion.yml permissions.deploy)' : undefined}
                className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                <Upload size={14} /> Deploy
              </button>
              {s.currentRelease && (
                <>
                  <button onClick={() => setDialog('restart')} disabled={run.busy} className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50">
                    <RotateCw size={14} /> Restart
                  </button>
                  <button
                    onClick={() => setDialog('stop')}
                    disabled={run.busy || s.container?.state !== 'running'}
                    className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                  >
                    <Power size={14} /> Stop
                  </button>
                </>
              )}
            </>
          )}
          {levels.manage && (
            <button
              onClick={() => setDialog('delete')}
              disabled={run.busy}
              aria-label={`Delete ${app}`}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-red-500 hover:bg-red-500/10 disabled:opacity-50"
            >
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
      </div>

      <DeployRunPanel state={run.state} onDismiss={run.dismiss} />

      {levels.operate && !canDeploy && (
        <p role="note" className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            Deploying and rolling back <span className="font-mono">{app}</span> needs manage access to deployments on this server: its bastion.yml sets{' '}
            <span className="font-mono">permissions.deploy: manage</span>. You can still restart and stop it.
          </span>
        </p>
      )}

      {s.configError && (
        <p className="mb-4 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-600">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap break-words">bastion.yml is not valid: {s.configError}</span>
        </p>
      )}

      <div role="tablist" aria-label="App" className="mb-4 flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn('border-b-2 px-3 py-2 text-sm', tab === t.id ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-5">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
            <Fact label="Current release">
              <span className="font-mono">{s.currentRelease ?? '—'}</span>
            </Fact>
            <Fact label="Previous release">
              <span className="font-mono">{s.previousRelease ?? '—'}</span>
            </Fact>
            <Fact label="Build">{s.config ? `${s.config.build.type}${s.config.build.node ? ` · Node ${s.config.build.node}` : ''}` : (s.buildType ?? '—')}</Fact>
            <Fact label="Container">
              {s.container ? (
                <>
                  <span className="break-all font-mono">{s.container.name}</span>
                  <span className="block text-xs text-muted-foreground">{s.container.status}</span>
                </>
              ) : (
                '—'
              )}
            </Fact>
            <Fact label="Domains">{s.domains.join(', ') || '—'}</Fact>
            <Fact label="Who may deploy">{deployLevel === 'manage' ? 'Manage access (permissions.deploy)' : 'Operate access'}</Fact>
            <Fact label="Limits">
              {s.config ? `${s.config.run.memory ?? 'no memory limit'} · ${s.config.run.cpus != null ? `${s.config.run.cpus} CPU` : 'no CPU limit'}` : '—'}
            </Fact>
          </dl>
          {s.container && <Runtime serverId={serverId} containerId={s.container.id} running={s.container.state === 'running'} />}
        </div>
      )}
      {tab === 'releases' && (
        <ReleasesPanel serverId={serverId} app={app} canOperate={canDeploy} busy={run.busy} onRollback={(release) => void run.rollback(release)} />
      )}
      {tab === 'config' && <ConfigEditor serverId={serverId} app={app} canManage={levels.manage} />}
      {tab === 'env' && levels.manage && <EnvEditor serverId={serverId} app={app} />}
      {tab === 'domains' && (
        <DomainsPanel serverId={serverId} app={app} status={s} proxyMode={proxyMode} canOperate={levels.operate} onEdit={levels.manage ? () => setTab('config') : undefined} />
      )}

      {dialog === 'deploy' && (
        <DeploySourceDialog app={app} build={s.config?.build ?? null} onDeploy={(label, pack) => void run.deploy(label, pack)} onClose={() => setDialog(null)} />
      )}
      {(dialog === 'restart' || dialog === 'stop') && (
        <ConfirmDialog
          title={dialog === 'restart' ? `Restart ${app}` : `Stop ${app}`}
          subject={s.container?.name ?? app}
          confirmLabel={dialog === 'restart' ? 'Restart' : 'Stop'}
          danger={dialog === 'stop'}
          onConfirm={() => action(dialog)}
          onClose={() => setDialog(null)}
        >
          <p>
            {dialog === 'restart'
              ? 'The container restarts with the environment it started with (deploy again to apply .env changes); the site is briefly unavailable.'
              : 'The site stops answering until the app is restarted or deployed again.'}
          </p>
        </ConfirmDialog>
      )}
      {dialog === 'delete' && (
        <ConfirmDialog
          title={`Delete ${app}`}
          subject={app}
          confirmLabel="Delete app"
          options={[{ key: 'purge', label: 'Also delete its bastion.yml, .env and volumes', hint: 'Without this they stay on the server, and deploying again restores the app.' }]}
          onConfirm={async (opts) => {
            const res = await api.delete<{ proxy?: DeployNginxApplyResult }>(appPath(serverId, app, opts.purge ? '?purge=1' : ''));
            toast.success(`${app} deleted`);
            const nginx = nginxSyncMessage(res?.proxy);
            if (nginx) toast.warning(nginx);
            await qc.invalidateQueries({ queryKey: deployKeys.apps(serverId) });
            onBack();
          }}
          onClose={() => setDialog(null)}
        >
          <p>Takes the app out of the proxy and removes its containers, images and releases. This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
