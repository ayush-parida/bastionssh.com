import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { KubePermissions } from '@smt/shared';
import { Loader2, SquareTerminal } from 'lucide-react';
import { toast } from 'sonner';
import { openPodShell, podShellUrl, usePodDetail, type PodTerminalState } from '@/lib/kube-pods.js';
import ContainerLanes, { LifecycleStrip } from './ContainerLanes.js';

/**
 * The top of a pod's panel (spec §5.3): where it is in its life, its
 * containers as lanes with usage against requests and limits, and "Open
 * shell" (operators and up when the org allows it). `version` changes when
 * the change feed says the pod changed, so the lanes follow it.
 */
export default function PodOverview({
  clusterId,
  namespace,
  name,
  permissions,
  version,
  onLogs,
}: {
  clusterId: string;
  namespace: string;
  name: string;
  permissions: KubePermissions | undefined;
  version: number;
  onLogs: (container: string, previous: boolean) => void;
}) {
  const navigate = useNavigate();
  const pod = usePodDetail(clusterId, namespace, name);
  const [opening, setOpening] = useState(false);
  const { refetch } = pod;

  useEffect(() => {
    if (version) void refetch();
  }, [version, refetch]);

  async function shell(container?: string) {
    setOpening(true);
    try {
      const session = await openPodShell(clusterId, namespace, name, container ? { container } : {});
      const state: PodTerminalState = { sessionId: session.sessionId, recording: session.recording, pod: session.pod };
      navigate(podShellUrl(clusterId), { state });
    } catch (err) {
      toast.error((err as Error).message);
      setOpening(false);
    }
  }

  if (pod.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" /> Loading containers…
      </p>
    );
  }
  if (pod.error) return <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(pod.error as Error).message}</p>;
  const d = pod.data;
  if (!d) return null;

  const canExec = !!permissions?.exec;
  const defaultRunning = d.containers.some((c) => c.name === d.defaultContainer && c.state === 'running');
  return (
    <div className="space-y-4" data-testid="pod-overview">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <LifecycleStrip steps={d.lifecycle} />
        </div>
        {canExec && (
          <button
            onClick={() => void shell()}
            disabled={opening || !defaultRunning}
            title={
              defaultRunning
                ? `Open a shell in ${d.defaultContainer} (recorded if your organisation records sessions)`
                : `${d.defaultContainer ?? 'The container'} is not running`
            }
            data-testid="open-pod-shell"
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {opening ? <Loader2 size={14} className="animate-spin" /> : <SquareTerminal size={14} />} Open shell
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          Phase <span className="text-foreground">{d.phase}</span>
        </span>
        {d.nodeName && (
          <span>
            on node <span className="font-mono text-foreground">{d.nodeName}</span>
          </span>
        )}
        {d.podIP && (
          <span>
            IP <span className="font-mono text-foreground">{d.podIP}</span>
          </span>
        )}
      </div>
      <ContainerLanes
        pod={d}
        canLogs={!!permissions?.logs}
        canExec={canExec}
        onLogs={onLogs}
        onShell={(c) => void shell(c)}
        shellBusy={opening}
      />
    </div>
  );
}
