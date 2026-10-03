import { useQuery } from '@tanstack/react-query';
import type { KubeObjectInsight, KubeObjectRef } from '@smt/shared';
import { kubeObjectPath } from '@smt/shared';
import { CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api.js';
import { kubeKeys, kubePath, type KubeTab } from '@/lib/kube.js';
import DiagnosisCard from './DiagnosisCard.js';
import { EventLines } from './EventsTimeline.js';
import { ContainerLanes, LifecycleStrip } from './PodLifecycle.js';
import RolloutTimeline from './RolloutTimeline.js';

/**
 * The understanding half of an object's panel (K2): what is wrong with it in
 * plain words (diagnoses with evidence), its rollout timeline or its pod
 * lifecycle and containers, and its events. Its query sits under the
 * object's key, so the panel's change feed refreshes it; events are not on
 * that feed, so it also refreshes on a slow timer.
 */
export default function ObjectInsight({
  clusterId,
  objectRef,
  fromTab,
}: {
  clusterId: string;
  objectRef: Pick<KubeObjectRef, 'resource' | 'namespace' | 'name'>;
  fromTab: KubeTab;
}) {
  const path = kubeObjectPath(objectRef);
  const insight = useQuery<KubeObjectInsight>({
    queryKey: kubeKeys.insight(clusterId, path),
    queryFn: () => api.get(kubePath(clusterId, `/${path}/insight`)),
    retry: false,
    refetchInterval: 20_000,
  });
  const d = insight.data;
  if (!d) return null;
  const healthy = !d.diagnoses.length && ['pods', 'deployments', 'statefulsets', 'daemonsets', 'services', 'nodes', 'persistentvolumeclaims'].includes(objectRef.resource);
  return (
    <div className="space-y-6" data-testid="object-insight">
      {d.diagnoses.length > 0 ? (
        <div className="space-y-2" data-testid="object-diagnoses">
          <p className="text-sm font-medium">What’s wrong</p>
          {d.diagnoses.map((x, i) => (
            <DiagnosisCard key={`${x.id}/${x.subject.name}/${i}`} clusterId={clusterId} diagnosis={x} fromTab={fromTab} showSubject={x.subject.name !== objectRef.name} />
          ))}
        </div>
      ) : (
        healthy && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 size={15} className="text-emerald-500" /> No known problems.
          </p>
        )
      )}
      {d.lifecycle && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Lifecycle</p>
          <LifecycleStrip steps={d.lifecycle} />
        </div>
      )}
      {d.containers && d.containers.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Containers</p>
          <ContainerLanes lanes={d.containers} />
        </div>
      )}
      {d.rollout && <RolloutTimeline rollout={d.rollout} />}
      <div className="space-y-2">
        <p className="text-sm font-medium">Events</p>
        <EventLines events={d.events} />
      </div>
    </div>
  );
}
