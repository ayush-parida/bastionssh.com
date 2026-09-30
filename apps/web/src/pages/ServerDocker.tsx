import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type {
  DockerContainer,
  DockerEngineInfo,
  DockerImage,
  DockerNetwork,
  DockerServerStatus,
  DockerVolume,
} from '@smt/shared';
import { ArrowLeft, Container, Radar } from 'lucide-react';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { dockerKeys, dockerPath, useDockerEvents } from '@/lib/docker.js';
import DockerHeader from '@/components/docker/DockerHeader.js';
import ContainersTable from '@/components/docker/ContainersTable.js';
import ContainerDrawer from '@/components/docker/ContainerDrawer.js';
import { ImagesTable, NetworksTable, VolumesTable } from '@/components/docker/ResourceTables.js';
import { DetectDockerButton, DockerProblem, problemOf } from '@/components/docker/DetectDocker.js';

type Tab = 'containers' | 'images' | 'volumes' | 'networks';
const TABS: { id: Tab; label: string }[] = [
  { id: 'containers', label: 'Containers' },
  { id: 'images', label: 'Images' },
  { id: 'volumes', label: 'Volumes' },
  { id: 'networks', label: 'Networks' },
];

/**
 * A server's Docker: engine header, then containers, images, volumes and
 * networks. Lists refresh live from the engine's event stream while the page
 * is open. Detection happens on first use (or an admin's "Detect Docker").
 */
export default function ServerDockerPage() {
  const { id: serverId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('containers');
  const [showAll, setShowAll] = useState(true);
  // `?container=<id>` opens that container's drawer (links from the Containers page)
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(params.get('container'));

  const status = useQuery<DockerServerStatus>({
    queryKey: dockerKeys.status(serverId),
    queryFn: () => api.get(dockerPath(serverId)),
    enabled: !!serverId,
  });
  const on = status.data?.docker.mode === 'auto';

  // First use: listing containers detects Docker when nothing was detected yet
  const containers = useQuery<DockerContainer[]>({
    queryKey: [...dockerKeys.containers(serverId), showAll],
    queryFn: () => api.get(dockerPath(serverId, `/containers?all=${showAll ? 1 : 0}`)),
    enabled: on,
    retry: false,
  });
  const reachable = containers.isSuccess;

  const info = useQuery<DockerEngineInfo>({
    queryKey: dockerKeys.info(serverId),
    queryFn: () => api.get(dockerPath(serverId, '/info')),
    enabled: reachable,
    staleTime: 30_000,
  });
  const images = useQuery<DockerImage[]>({
    queryKey: dockerKeys.images(serverId),
    queryFn: () => api.get(dockerPath(serverId, '/images')),
    enabled: reachable && tab === 'images',
  });
  const volumes = useQuery<DockerVolume[]>({
    queryKey: dockerKeys.volumes(serverId),
    queryFn: () => api.get(dockerPath(serverId, '/volumes')),
    enabled: reachable && tab === 'volumes',
  });
  const networks = useQuery<DockerNetwork[]>({
    queryKey: dockerKeys.networks(serverId),
    queryFn: () => api.get(dockerPath(serverId, '/networks')),
    enabled: reachable && tab === 'networks',
  });

  useDockerEvents(serverId, reachable);

  const back = (
    <button
      onClick={() => navigate('/servers')}
      className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft size={14} /> Back to servers
    </button>
  );

  if (status.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!status.data) {
    return (
      <div className="p-6">
        {back}
        <p className="text-sm text-muted-foreground">{status.error ? (status.error as Error).message : 'Server not found.'}</p>
      </div>
    );
  }
  const { data } = status;
  // Re-read after refetches so the drawer shows the container's current state
  const current = selected ? containers.data?.find((c) => c.id === selected) : undefined;

  return (
    <div className="p-6">
      {back}
      <div className="mb-4 flex items-center gap-3">
        <Container size={22} className="text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Docker</h1>
          <p className="text-sm text-muted-foreground">{data.serverName}</p>
        </div>
      </div>

      {!on ? (
        <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          Docker is turned off for this server. An admin can turn it on in the server's settings.
        </p>
      ) : containers.isLoading ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          <Radar size={15} className="animate-pulse" />
          {data.docker.detectedAt ? 'Loading containers…' : 'Looking for Docker on this server…'}
        </div>
      ) : containers.error ? (
        <div className="space-y-3">
          <DockerProblem {...problemOf(containers.error)} onRetry={() => containers.refetch()} />
          {data.permissions.configure && <DetectDockerButton serverId={serverId} />}
        </div>
      ) : (
        <>
          <DockerHeader status={data} info={info.data} />

          <div className="mb-4 flex gap-1 border-b border-border">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'border-b-2 px-3 py-2 text-sm',
                  tab === t.id ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
                {t.id === 'containers' && containers.data && (
                  <span className="ml-1.5 text-xs text-muted-foreground">{containers.data.length}</span>
                )}
              </button>
            ))}
          </div>

          {tab === 'containers' && (
            <ContainersTable
              containers={containers.data ?? []}
              showAll={showAll}
              onShowAll={setShowAll}
              onSelect={(c) => setSelected(c.id)}
              selectedId={selected}
            />
          )}
          {tab === 'images' &&
            (images.error ? (
              <DockerProblem {...problemOf(images.error)} />
            ) : images.data ? (
              <ImagesTable images={images.data} />
            ) : (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ))}
          {tab === 'volumes' &&
            (volumes.error ? (
              <DockerProblem {...problemOf(volumes.error)} />
            ) : volumes.data ? (
              <VolumesTable volumes={volumes.data} />
            ) : (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ))}
          {tab === 'networks' &&
            (networks.error ? (
              <DockerProblem {...problemOf(networks.error)} />
            ) : networks.data ? (
              <NetworksTable networks={networks.data} />
            ) : (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ))}
        </>
      )}

      {current && (
        <ContainerDrawer
          serverId={serverId}
          container={current}
          permissions={data.permissions}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
