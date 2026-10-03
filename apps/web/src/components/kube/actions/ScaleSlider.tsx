import { useEffect, useState } from 'react';
import type { KubeActionPreview, KubeScalableKind } from '@smt/shared';
import { KUBE_MAX_REPLICAS, kubeActionCommand } from '@smt/shared';
import { AlertTriangle, Scaling } from 'lucide-react';
import { useKubeAction } from '@/lib/kube-actions.js';
import ConfirmDialog from '@/components/docker/ConfirmDialog.js';
import ReplicaChange from './ReplicaRings.js';
import WhatThisDoes from './WhatThisDoes.js';

/** The autoscaler warning: scaling by hand fights it. */
function HpaWarning({ hpa }: { hpa: NonNullable<KubeActionPreview['hpa']> }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400" data-testid="hpa-warning">
      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
      <span>
        The autoscaler <span className="font-mono">{hpa.name}</span> controls this workload (between {hpa.minReplicas} and {hpa.maxReplicas}{' '}
        replicas) and will change the count again. Change its limits instead to make a lasting change.
      </span>
    </p>
  );
}

/**
 * Scale a Deployment or StatefulSet (spec §6): a slider and a number pick the
 * new count, rings show current → new as it moves, and the confirmation names
 * the workload. Sent as a patch of the `scale` subresource.
 */
export default function ScaleSlider({
  clusterId,
  kind,
  namespace,
  name,
  replicas,
  hpa,
}: {
  clusterId: string;
  kind: KubeScalableKind;
  namespace: string;
  name: string;
  replicas: NonNullable<KubeActionPreview['replicas']>;
  hpa: KubeActionPreview['hpa'];
}) {
  const run = useKubeAction(clusterId);
  const [value, setValue] = useState(replicas.desired);
  const [confirming, setConfirming] = useState(false);

  // Follow changes made elsewhere (the change feed refreshes the preview) unless one is being picked
  useEffect(() => {
    if (!confirming) setValue(replicas.desired);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replicas.desired]);

  const max = Math.min(KUBE_MAX_REPLICAS, Math.max(10, replicas.desired * 2, value));
  const clamp = (n: number) => Math.max(0, Math.min(KUBE_MAX_REPLICAS, Math.round(Number.isFinite(n) ? n : 0)));
  const command = kubeActionCommand('scale', { kind, namespace, name }, { replicas: value });

  return (
    <div className="space-y-3" data-testid="scale-slider">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Scaling size={14} /> Scale
        <span className="ml-auto text-xs font-normal text-muted-foreground">
          {replicas.ready} of {replicas.desired} ready
        </span>
      </div>
      <ReplicaChange current={replicas.desired} ready={replicas.ready} next={value} />
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={max}
          value={value}
          onChange={(e) => setValue(clamp(e.target.valueAsNumber))}
          className="flex-1 accent-primary"
          aria-label="Replicas"
        />
        <input
          type="number"
          min={0}
          max={KUBE_MAX_REPLICAS}
          value={value}
          onChange={(e) => setValue(clamp(e.target.valueAsNumber))}
          className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm tabular-nums"
          aria-label="Replica count"
        />
      </div>
      {hpa && <HpaWarning hpa={hpa} />}
      <div className="flex items-center justify-end gap-2">
        {value !== replicas.desired && (
          <button type="button" onClick={() => setValue(replicas.desired)} className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted">
            Reset
          </button>
        )}
        <button
          type="button"
          disabled={value === replicas.desired}
          onClick={() => setConfirming(true)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          Scale…
        </button>
      </div>

      {confirming && (
        <ConfirmDialog
          title={`Scale ${kind}`}
          subject={`${kind.toLowerCase()}/${name} in ${namespace}`}
          confirmLabel={`Scale ${name} to ${value}`}
          danger={value === 0}
          onConfirm={() => run('scale', { kind, namespace, name, replicas: value })}
          onClose={() => setConfirming(false)}
        >
          <ReplicaChange current={replicas.desired} ready={replicas.ready} next={value} />
          {value === 0 && (
            <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600">
              With 0 replicas nothing runs: the app is down until it is scaled up again.
            </p>
          )}
          {hpa && <HpaWarning hpa={hpa} />}
          <WhatThisDoes command={command}>
            Sets the desired replica count of {name} to {value}. Kubernetes then
            {value > replicas.desired ? ' starts new pods' : value < replicas.desired ? ' stops the extra pods' : ' keeps the pods as they are'}; nothing else
            about the workload changes.
          </WhatThisDoes>
        </ConfirmDialog>
      )}
    </div>
  );
}
