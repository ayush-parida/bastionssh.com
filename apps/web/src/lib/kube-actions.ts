import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  KubeActionId,
  KubeActionPreview,
  KubeActionResult,
  KubeDeletePodRequest,
  KubeNodeActionRequest,
  KubeObjectRef,
  KubeRestartRequest,
  KubeRollbackRequest,
  KubeScaleRequest,
  KubeSuspendCronJobRequest,
  KubeTemplateContainer,
  KubeTriggerCronJobRequest,
} from '@smt/shared';
import { kubeObjectPath } from '@smt/shared';
import { api } from '@/lib/api.js';
import { kubePath, useKubeCluster } from '@/lib/kube.js';

/** Calls behind the guided actions (K3) and the preview their panels open with. */

/** The body each action takes. */
export interface KubeActionBodies {
  scale: KubeScaleRequest;
  restart: KubeRestartRequest;
  rollback: KubeRollbackRequest;
  'delete-pod': KubeDeletePodRequest;
  cordon: KubeNodeActionRequest;
  uncordon: KubeNodeActionRequest;
  'suspend-cronjob': KubeSuspendCronJobRequest;
  'trigger-cronjob': KubeTriggerCronJobRequest;
}

/**
 * Under the object's own key, so the change feed that keeps an object panel
 * live (`kubeKeys.object`) refreshes its preview too.
 */
export const previewKey = (clusterId: string, path: string) => ['kube', clusterId, 'object', path, 'actions'] as const;

/** What the action panels show for an object, and which actions the caller may take on it. */
export function useActionPreview(clusterId: string, ref: Pick<KubeObjectRef, 'resource' | 'namespace' | 'name'>, enabled = true) {
  const path = kubeObjectPath(ref);
  return useQuery<KubeActionPreview>({
    queryKey: previewKey(clusterId, path),
    queryFn: () => api.get(kubePath(clusterId, `/actions/preview/${path.replace(/^objects\//, '')}`)),
    enabled,
    retry: false,
  });
}

/** What the caller may do on the cluster (the same matrix the server enforces). */
export function useKubePermissions(clusterId: string) {
  return useKubeCluster(clusterId).data?.permissions ?? null;
}

/**
 * Run an action: on success, toast what it did and refresh every view of the
 * cluster (the change feed would too, a moment later); a failure throws for
 * the dialog to show.
 */
export function useKubeAction(clusterId: string) {
  const qc = useQueryClient();
  return async function run<A extends KubeActionId>(action: A, body: KubeActionBodies[A]): Promise<KubeActionResult> {
    const result = await api.post<KubeActionResult>(kubePath(clusterId, `/actions/${action}`), body);
    if (result.changed) toast.success(result.message);
    else toast.message(result.message);
    void qc.invalidateQueries({ queryKey: ['kube', clusterId] });
    return result;
  };
}

/** How one container differs between two revisions: image, and env var names (never values). */
export interface KubeContainerDiff {
  name: string;
  change: 'added' | 'removed' | 'changed' | 'same';
  imageFrom: string | null;
  imageTo: string | null;
  envAdded: string[];
  envRemoved: string[];
}

/** Compare the containers of the running revision (`from`) with the one rolled back to (`to`). */
export function revisionDiff(from: KubeTemplateContainer[], to: KubeTemplateContainer[]): KubeContainerDiff[] {
  const names = [...new Set([...to.map((c) => c.name), ...from.map((c) => c.name)])];
  return names.map((name) => {
    const a = from.find((c) => c.name === name) ?? null;
    const b = to.find((c) => c.name === name) ?? null;
    const envAdded = b ? b.envNames.filter((n) => !a?.envNames.includes(n)) : [];
    const envRemoved = a ? a.envNames.filter((n) => !b?.envNames.includes(n)) : [];
    const change = !a ? 'added' : !b ? 'removed' : a.image !== b.image || envAdded.length || envRemoved.length ? 'changed' : 'same';
    return { name, change, imageFrom: a?.image ?? null, imageTo: b?.image ?? null, envAdded, envRemoved };
  });
}
