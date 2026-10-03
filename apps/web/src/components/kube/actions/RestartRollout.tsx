import { useState } from 'react';
import type { KubeActionPreview, KubeRestartableKind, KubeUpdateStrategy } from '@smt/shared';
import { kubeActionCommand } from '@smt/shared';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { useKubeAction } from '@/lib/kube-actions.js';
import ConfirmDialog from '@/components/docker/ConfirmDialog.js';
import WhatThisDoes from './WhatThisDoes.js';

/** Pods drawn as a row being replaced left to right: old (grey) → new (green). */
function ReplaceStrip({ count }: { count: number }) {
  const shown = Math.min(count, 12);
  return (
    <div className="flex items-center justify-center gap-3 py-1" aria-hidden>
      <div className="flex gap-1">
        {Array.from({ length: shown }, (_, i) => (
          <span key={i} className="size-3 rounded-[3px] border border-zinc-400 bg-zinc-400/40" />
        ))}
      </div>
      <RotateCw size={14} className="text-muted-foreground" />
      <div className="flex gap-1">
        {Array.from({ length: shown }, (_, i) => (
          <span key={i} className="size-3 rounded-[3px] border border-emerald-600 bg-emerald-500" />
        ))}
      </div>
      {count > shown && <span className="text-xs text-muted-foreground">+{count - shown}</span>}
    </div>
  );
}

/**
 * Restart a rollout (spec §6): every pod is replaced following the
 * workload's update strategy — one by one for the usual `RollingUpdate`, so
 * with more than one replica the app stays up; all at once for a
 * Deployment's `Recreate`; and not until each pod is deleted for `OnDelete`
 * — the panel says which. Sent as the `kubectl.kubernetes.io/restartedAt`
 * pod-template annotation, as `kubectl rollout restart` does.
 */
export default function RestartRollout({
  clusterId,
  kind,
  namespace,
  name,
  replicas,
  paused,
  strategy = 'RollingUpdate',
}: {
  clusterId: string;
  kind: KubeRestartableKind;
  namespace: string;
  name: string;
  replicas: KubeActionPreview['replicas'];
  paused?: boolean;
  strategy?: KubeUpdateStrategy;
}) {
  const run = useKubeAction(clusterId);
  const [confirming, setConfirming] = useState(false);
  const count = replicas?.desired ?? 0;
  const single = strategy === 'RollingUpdate' && kind !== 'DaemonSet' && count <= 1;
  const pods = kind === 'DaemonSet' ? `The pod on each of its ${count} node${count === 1 ? '' : 's'}` : `Its ${count} pod${count === 1 ? '' : 's'}`;
  const summary =
    strategy === 'Recreate'
      ? 'Stops every pod, then starts fresh ones: the app is down in between.'
      : strategy === 'OnDelete'
        ? 'Marks the pods for replacement; each is replaced only when it is deleted.'
        : 'Replaces every pod with a fresh one, one by one.';

  return (
    <div className="space-y-2" data-testid="restart-rollout">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <RotateCw size={14} /> Restart rollout
          </p>
          <p className="text-xs text-muted-foreground">
            {paused ? 'The rollout is paused; resume it before restarting.' : summary}
          </p>
        </div>
        <button
          type="button"
          disabled={paused}
          onClick={() => setConfirming(true)}
          className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40"
        >
          Restart…
        </button>
      </div>

      {confirming && (
        <ConfirmDialog
          title={`Restart ${kind}`}
          subject={`${kind.toLowerCase()}/${name} in ${namespace}`}
          confirmLabel={`Restart ${name}`}
          danger={strategy === 'Recreate' && count > 0}
          onConfirm={() => run('restart', { kind, namespace, name })}
          onClose={() => setConfirming(false)}
        >
          <ReplaceStrip count={count} />
          {strategy === 'Recreate' ? (
            <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600" data-testid="restart-strategy-warning">
              {pods} will all be stopped first, and only then are new ones started (its update strategy is Recreate): the app is unavailable until they
              are ready.
            </p>
          ) : strategy === 'OnDelete' ? (
            <p className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400" data-testid="restart-strategy-warning">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              Its update strategy is OnDelete: nothing is replaced now. Each pod picks up the restart only when it is deleted (use Restart this pod on each).
            </p>
          ) : (
            <p>{pods} will be replaced one by one; each new pod must be ready before the next old one stops.</p>
          )}
          {single && (
            <p className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              With {count === 0 ? 'no replicas there is nothing to replace' : 'a single replica the app may be briefly unavailable while it is replaced'}.
            </p>
          )}
          <WhatThisDoes command={kubeActionCommand('restart', { kind, namespace, name })}>
            Stamps the current time on the pod template (the <code className="font-mono">kubectl.kubernetes.io/restartedAt</code> annotation). The
            template changed, so Kubernetes rolls out new pods with the same image and settings.
          </WhatThisDoes>
        </ConfirmDialog>
      )}
    </div>
  );
}
