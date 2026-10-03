import type { KubeObjectRef, KubeResource, KubeRestartableKind, KubeScalableKind } from '@smt/shared';
import { Server } from 'lucide-react';
import { useActionPreview, useKubePermissions } from '@/lib/kube-actions.js';
import ScaleSlider from './ScaleSlider.js';
import RestartRollout from './RestartRollout.js';
import RollbackPicker from './RollbackPicker.js';
import DeletePod from './DeletePod.js';
import CordonToggle from './CordonToggle.js';
import CronJobActions from './CronJobActions.js';

/** Objects that have guided actions (spec §6). */
const ACTIONABLE: ReadonlySet<KubeResource> = new Set(['deployments', 'statefulsets', 'daemonsets', 'pods', 'nodes', 'cronjobs']);

const KIND: Partial<Record<KubeResource, KubeScalableKind | KubeRestartableKind>> = {
  deployments: 'Deployment',
  statefulsets: 'StatefulSet',
  daemonsets: 'DaemonSet',
};

/**
 * The guided actions of the object open in the panel (spec §6, K3), from
 * the server's preview: only the actions the caller's role and the org
 * settings allow are offered (the server enforces the same). A Deployment's
 * revision timeline shows for everyone; rolling back is for admins.
 */
export default function ObjectActions({
  clusterId,
  objectRef,
  onGone,
}: {
  clusterId: string;
  objectRef: Pick<KubeObjectRef, 'resource' | 'namespace' | 'name'>;
  /** The object no longer exists (a deleted pod). */
  onGone?: () => void;
}) {
  const permissions = useKubePermissions(clusterId);
  const actionable = ACTIONABLE.has(objectRef.resource);
  const preview = useActionPreview(clusterId, objectRef, actionable && !!permissions);
  const p = preview.data;
  if (!actionable || !p) return null;

  const can = (a: (typeof p.actions)[number]) => p.actions.includes(a);
  const { name } = objectRef;
  const namespace = objectRef.namespace ?? '';
  const kind = KIND[objectRef.resource];
  const parts: React.ReactNode[] = [];

  if ((kind === 'Deployment' || kind === 'StatefulSet') && can('scale') && p.replicas) {
    parts.push(<ScaleSlider key="scale" clusterId={clusterId} kind={kind} namespace={namespace} name={name} replicas={p.replicas} hpa={p.hpa ?? null} />);
  }
  if (kind && can('restart')) {
    parts.push(<RestartRollout key="restart" clusterId={clusterId} kind={kind} namespace={namespace} name={name} replicas={p.replicas} paused={p.paused} />);
  }
  if (p.revisions?.length) {
    parts.push(
      <RollbackPicker
        key="rollback"
        clusterId={clusterId}
        namespace={namespace}
        name={name}
        revisions={p.revisions}
        canRollback={can('rollback')}
        paused={p.paused}
      />,
    );
  }
  if (p.pod && can('delete-pod')) {
    parts.push(<DeletePod key="delete" clusterId={clusterId} namespace={namespace} name={name} pod={p.pod} onDeleted={onGone} />);
  }
  if (p.node && (can('cordon') || can('uncordon'))) {
    parts.push(
      <div key="cordon" className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Server size={14} /> Scheduling
          </p>
          <p className="text-xs text-muted-foreground">
            {p.node.unschedulable ? 'Cordoned: no new pods are placed here.' : 'New pods may be placed here.'} {p.node.pods} pod
            {p.node.pods === 1 ? '' : 's'} running{p.node.daemonSetPods ? `, ${p.node.daemonSetPods} from DaemonSets` : ''}.
          </p>
        </div>
        <CordonToggle clusterId={clusterId} node={name} unschedulable={p.node.unschedulable} pods={p.node.pods} />
      </div>,
    );
  }
  if (p.cronJob && (can('suspend-cronjob') || can('trigger-cronjob'))) {
    parts.push(
      <CronJobActions
        key="cronjob"
        clusterId={clusterId}
        namespace={namespace}
        name={name}
        cronJob={p.cronJob}
        canSuspend={can('suspend-cronjob')}
        canTrigger={can('trigger-cronjob')}
      />,
    );
  }
  if (!parts.length) return null;

  return (
    <section className="divide-y divide-border rounded-md border border-border" data-testid="object-actions" aria-label="Actions">
      {parts.map((part, i) => (
        <div key={i} className="px-3 py-3">
          {part}
        </div>
      ))}
    </section>
  );
}
