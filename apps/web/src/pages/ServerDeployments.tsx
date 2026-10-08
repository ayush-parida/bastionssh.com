import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { DeployProxyState, DeployServerState, Server } from '@smt/shared';
import { ArrowLeft, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { deployErrorCode, deployKeys, deployPath, type DeployAppRow } from '@/lib/deploy.js';
import { useAccessLevels } from '@/hooks/useAccessLevels.js';
import { useModule } from '@/hooks/useModules.js';
import SetupPanel from '@/components/deploy/SetupPanel.js';
import AppList from '@/components/deploy/AppList.js';
import AppDetail from '@/components/deploy/AppDetail.js';
import NewAppDialog from '@/components/deploy/NewAppDialog.js';
import ServiceCatalogDialog from '@/components/deploy/ServiceCatalogDialog.js';
import DocsLink from '@/components/docs/DocsLink.js';
import { DEPLOY_DOCS } from '@smt/shared';

/**
 * A server's Deployments tab (deployments spec §7): Setup, then the apps on
 * the server, or one app at `/servers/:id/deployments/:app`. What a member
 * may do is the lower of their Deployments module level and their level on
 * the server (spec §2.7) — view sees, operate deploys and rolls back,
 * manage sets up, edits config and secrets, and deletes. The server decides
 * regardless; buttons it would refuse are hidden.
 */
export default function ServerDeploymentsPage() {
  const { id: serverId = '', app } = useParams<{ id: string; app?: string }>();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [catalog, setCatalog] = useState(false);
  const access = useAccessLevels('server');
  const moduleOperate = useModule('deployments', 'operate');
  const moduleManage = useModule('deployments', 'manage');
  const levels = {
    operate: moduleOperate && access.can(serverId, 'operate'),
    manage: moduleManage && access.can(serverId, 'manage'),
  };

  const servers = useQuery<Server[]>({ queryKey: ['servers'], queryFn: () => api.get('/servers') });
  const server = servers.data?.find((s) => s.id === serverId);

  const state = useQuery<DeployServerState>({
    queryKey: deployKeys.state(serverId),
    queryFn: () => api.get(deployPath(serverId)),
    enabled: !!serverId,
    retry: false,
  });
  const ready = state.data?.integrity === 'ok';
  // Reading the state upgraded the server's bastionctl to the one this BastionSSH ships: say so, once per answer
  const announced = useRef<DeployServerState | null>(null);
  useEffect(() => {
    const upgraded = state.data?.upgraded;
    if (!upgraded || announced.current === state.data) return;
    announced.current = state.data ?? null;
    toast.info(`bastionctl upgraded to ${upgraded.to}${upgraded.from ? ` (was ${upgraded.from})` : ''}`);
  }, [state.data]);
  // The proxy mode and, in nginx mode, what an administrator still has to do; optional (an older server answers 404)
  const proxy = useQuery<DeployProxyState>({
    queryKey: deployKeys.proxy(serverId),
    queryFn: () => api.get(deployPath(serverId, '/proxy')),
    enabled: !!state.data,
    retry: false,
    staleTime: 60_000,
  });
  const proxyMode = proxy.data?.mode ?? 'caddy';
  const apps = useQuery<DeployAppRow[]>({
    queryKey: deployKeys.apps(serverId),
    queryFn: () => api.get(deployPath(serverId, '/apps')),
    enabled: ready && !app,
    retry: false,
  });

  const openApp = (name: string | null) => navigate(name ? `/servers/${serverId}/deployments/${encodeURIComponent(name)}` : `/servers/${serverId}/deployments`);
  const appsCode = deployErrorCode(apps.error);

  return (
    <div className="p-6">
      <button
        onClick={() => navigate('/servers')}
        className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={14} /> Back to servers
      </button>
      <div className="mb-4 flex items-center gap-3">
        <Rocket size={22} className="text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Deployments</h1>
          <p className="text-sm text-muted-foreground">{server?.name ?? serverId}</p>
        </div>
        <DocsLink to={DEPLOY_DOCS.overview} className="ml-auto text-sm">
          How to deploy
        </DocsLink>
      </div>

      {state.isLoading ? (
        <p className="text-sm text-muted-foreground">Connecting to the server…</p>
      ) : state.error || !state.data ? (
        <p className="rounded-lg border border-border bg-card p-4 text-sm text-red-600">{state.error ? (state.error as Error).message : 'Server not found.'}</p>
      ) : (
        <>
          <SetupPanel serverId={serverId} state={state.data} proxy={proxy.data ?? null} canManage={levels.manage} canOperate={levels.operate} compact={ready} />
          {ready &&
            (app ? (
              <AppDetail serverId={serverId} app={app} proxyMode={proxyMode} kernelVersion={state.data.kernelVersion ?? null} levels={levels} onBack={() => openApp(null)} />
            ) : apps.isLoading ? (
              <p className="text-sm text-muted-foreground">Reading apps from the server…</p>
            ) : apps.error ? (
              <p className="rounded-lg border border-border bg-card p-4 text-sm text-red-600">
                {(apps.error as Error).message}
                {appsCode === 'bastionctl_mismatch' && (
                  <>
                    {' — reinstall bastionctl above. '}
                    <DocsLink to={`${DEPLOY_DOCS.troubleshooting}#integrity-check-failed-reinstall`}>Why?</DocsLink>
                  </>
                )}
              </p>
            ) : (
              <AppList
                apps={apps.data ?? []}
                onOpen={openApp}
                onNew={levels.manage ? () => setCreating(true) : undefined}
                onNewService={levels.manage ? () => setCatalog(true) : undefined}
              />
            ))}
        </>
      )}

      {catalog && (
        <ServiceCatalogDialog
          serverId={serverId}
          existing={(apps.data ?? []).map((a) => a.name)}
          proxyMode={proxyMode}
          kernelVersion={state.data?.kernelVersion ?? null}
          onOpen={(name) => {
            setCatalog(false);
            openApp(name);
          }}
          onClose={() => setCatalog(false)}
        />
      )}
      {creating && (
        <NewAppDialog
          serverId={serverId}
          existing={(apps.data ?? []).map((a) => a.name)}
          proxyMode={proxyMode}
          onCreated={(name) => {
            setCreating(false);
            openApp(name);
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}
