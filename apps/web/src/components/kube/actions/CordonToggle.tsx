import { useState } from 'react';
import { kubeActionCommand } from '@smt/shared';
import { useKubeAction, useKubePermissions } from '@/lib/kube-actions.js';
import { cn } from '@/lib/utils.js';
import ConfirmDialog from '@/components/docker/ConfirmDialog.js';
import WhatThisDoes from './WhatThisDoes.js';

/**
 * Cordon / uncordon a node (spec §6) as a switch — on the map's node cards,
 * in the Nodes table and in a node's panel. "On" means the node accepts new
 * pods. Admins only; for everyone else it renders nothing (the Cordoned badge
 * still shows the state). Cordoning moves nothing: pods already there keep
 * running — the confirmation says so.
 */
export default function CordonToggle({
  clusterId,
  node,
  unschedulable,
  pods,
  compact = false,
}: {
  clusterId: string;
  node: string;
  unschedulable: boolean;
  /** Pods running there now, for the explanation. */
  pods?: number;
  compact?: boolean;
}) {
  const permissions = useKubePermissions(clusterId);
  const run = useKubeAction(clusterId);
  const [confirming, setConfirming] = useState(false);
  if (!permissions?.cordon) return null;

  const action = unschedulable ? 'uncordon' : 'cordon';
  const schedulable = !unschedulable;

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={schedulable}
        aria-label={`Schedule new pods on ${node}`}
        title={schedulable ? 'Accepting new pods — click to cordon' : 'Cordoned — click to accept new pods again'}
        data-testid="cordon-toggle"
        onClick={() => setConfirming(true)}
        className={cn('flex shrink-0 items-center gap-1.5 rounded-md text-xs', compact ? 'px-1 py-0.5' : 'px-2 py-1 hover:bg-muted')}
      >
        <span className={cn('relative h-4 w-7 rounded-full transition-colors', schedulable ? 'bg-emerald-500' : 'bg-zinc-400')}>
          <span className={cn('absolute top-0.5 size-3 rounded-full bg-white shadow transition-[left]', schedulable ? 'left-3.5' : 'left-0.5')} />
        </span>
        {!compact && <span className="text-muted-foreground">{schedulable ? 'Schedulable' : 'Cordoned'}</span>}
      </button>

      {confirming && (
        <ConfirmDialog
          title={unschedulable ? 'Uncordon node' : 'Cordon node'}
          subject={`node/${node}`}
          confirmLabel={unschedulable ? `Uncordon ${node}` : `Cordon ${node}`}
          danger={false}
          onConfirm={() => run(action, { name: node })}
          onClose={() => setConfirming(false)}
        >
          {unschedulable ? (
            <p>The scheduler may place new pods on {node} again.</p>
          ) : (
            <p>
              No new pods will be scheduled on {node}.
              {pods !== undefined && ` The ${pods} pod${pods === 1 ? '' : 's'} already there keep${pods === 1 ? 's' : ''} running`}
              {pods === undefined && ' Pods already there keep running'} — cordoning moves nothing. Use it before maintenance, or to stop a misbehaving node
              from taking more work.
            </p>
          )}
          <WhatThisDoes command={kubeActionCommand(action, { kind: 'Node', namespace: null, name: node })}>
            Sets <code className="font-mono">spec.unschedulable</code> to {String(!unschedulable)} on the node.
          </WhatThisDoes>
        </ConfirmDialog>
      )}
    </>
  );
}
