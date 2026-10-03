import { useState } from 'react';
import type { KubeActionPreview } from '@smt/shared';
import { kubeActionCommand } from '@smt/shared';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useKubeAction } from '@/lib/kube-actions.js';
import ConfirmDialog from '@/components/docker/ConfirmDialog.js';
import WhatThisDoes from './WhatThisDoes.js';

/**
 * Delete a pod (spec §6). A pod whose owner replaces it is offered as
 * "Restart this pod" — its controller starts a replacement — while a bare
 * pod, or one whose Job already finished, gets a stronger warning: nothing
 * brings it back.
 */
export default function DeletePod({
  clusterId,
  namespace,
  name,
  pod,
  onDeleted,
}: {
  clusterId: string;
  namespace: string;
  name: string;
  pod: NonNullable<KubeActionPreview['pod']>;
  onDeleted?: () => void;
}) {
  const run = useKubeAction(clusterId);
  const [confirming, setConfirming] = useState(false);
  const owner = pod.owner;
  const recreated = pod.recreated && !!owner;
  const command = kubeActionCommand('delete-pod', { kind: 'Pod', namespace, name });

  return (
    <div className="space-y-2" data-testid="delete-pod">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            {recreated ? <RotateCcw size={14} /> : <Trash2 size={14} />} {recreated ? 'Restart this pod' : 'Delete this pod'}
          </p>
          <p className="text-xs text-muted-foreground">
            {recreated
              ? `Its ${owner!.kind} ${owner!.name} starts a new one in its place.`
              : owner
                ? `Its ${owner.kind} ${owner.name} has finished: nothing will recreate it.`
                : 'It has no owner: nothing will recreate it.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={
            recreated
              ? 'shrink-0 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted'
              : 'shrink-0 rounded-md border border-red-500/50 px-3 py-1.5 text-sm text-red-600 hover:bg-red-500/10'
          }
        >
          {recreated ? 'Restart…' : 'Delete…'}
        </button>
      </div>

      {confirming && (
        <ConfirmDialog
          title={recreated ? 'Restart pod' : 'Delete pod'}
          subject={`pod/${name} in ${namespace}`}
          confirmLabel={recreated ? `Restart ${name}` : `Delete ${name}`}
          danger={!recreated}
          onConfirm={async () => {
            await run('delete-pod', { namespace, name });
            onDeleted?.();
          }}
          onClose={() => setConfirming(false)}
        >
          {recreated ? (
            <p>
              The pod is deleted and its {owner!.kind} <span className="font-mono">{owner!.name}</span> starts a fresh one, possibly on another node. It gets
              its usual grace period to shut down.
            </p>
          ) : owner ? (
            <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">
              Its {owner.kind} <span className="font-mono">{owner.name}</span> has already finished, so nothing starts this pod again. Deleting it removes it,
              and its logs, for good.
            </p>
          ) : (
            <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">
              This pod was created on its own — no Deployment, StatefulSet, DaemonSet or Job owns it. Once deleted it is gone for good, along with anything
              stored inside it.
            </p>
          )}
          <WhatThisDoes command={command}>
            Deletes the pod object{pod.nodeName ? ` running on ${pod.nodeName}` : ''}; the kubelet stops its containers.
            {recreated ? ' Its owner notices a pod is missing and creates a replacement.' : ''}
          </WhatThisDoes>
        </ConfirmDialog>
      )}
    </div>
  );
}
