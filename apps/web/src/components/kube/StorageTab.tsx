import { useQuery } from '@tanstack/react-query';
import type { KubeClaimItem, KubeStorageClassItem, KubeStorageView, KubeVolumeItem } from '@smt/shared';
import { ArrowRight, Database, HardDrive, Hourglass, Layers, Loader2 } from 'lucide-react';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { kubeKeys, kubePath, useKubeChanges } from '@/lib/kube.js';
import DiagnosisCard from './DiagnosisCard.js';
import UsedBy, { ObjectChip } from './UsedBy.js';

/**
 * Storage (spec §5.5): each claim as a chain — what uses it → the claim →
 * the volume holding the data — coloured like the rest of the cluster
 * (green bound, amber waiting, red no storage), with the plain-language
 * reason a pending claim has none. Below: the storage classes (which one is
 * the default, and when it creates storage) and volumes no claim holds. Live.
 */

const PHASE_STYLE: Record<string, { box: string; dot: string; word: string }> = {
  Bound: { box: 'border-emerald-500/60', dot: 'bg-emerald-500', word: 'Has storage' },
  Pending: { box: 'border-amber-500/70', dot: 'bg-amber-500', word: 'Waiting for storage' },
  Lost: { box: 'border-red-500/70', dot: 'bg-red-500', word: 'Storage lost' },
};

/** Volume phases in words. */
const VOLUME_PHASE: Record<string, string> = {
  Available: 'Free — a new claim can use it',
  Bound: 'In use by a claim',
  Released: 'Its claim was deleted; the data is kept until someone removes it',
  Failed: 'Kubernetes could not clean it up after its claim was deleted',
};

/** `ReadWriteOnce` → words. */
const ACCESS_MODE: Record<string, string> = {
  ReadWriteOnce: 'one node at a time',
  ReadOnlyMany: 'read-only, many nodes',
  ReadWriteMany: 'many nodes',
  ReadWriteOncePod: 'one pod at a time',
};

function bindingWords(mode: string | null): string {
  return mode === 'WaitForFirstConsumer' ? 'creates storage when a pod first uses it' : 'creates storage as soon as it is claimed';
}

function ClaimRow({ clusterId, claim, classes }: { clusterId: string; claim: KubeClaimItem; classes: KubeStorageClassItem[] | null }) {
  const lateBinding =
    claim.phase === 'Pending' &&
    !claim.problem &&
    classes?.find((c) => c.name === (claim.storageClass ?? classes.find((d) => d.isDefault)?.name))?.bindingMode === 'WaitForFirstConsumer';
  const style = claim.problem ? PHASE_STYLE.Lost! : (PHASE_STYLE[claim.phase] ?? PHASE_STYLE.Pending!);
  const word = claim.problem ? 'No storage' : lateBinding ? 'Waiting for its first pod' : style.word;
  return (
    <li className="space-y-2 rounded-lg border border-border bg-card p-3" data-testid="storage-claim" data-phase={claim.phase}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <div className={cn('flex min-w-0 items-center gap-2 rounded-md border-2 px-2.5 py-1.5', style.box)}>
          <Database size={15} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0 leading-tight">
            <ObjectChip clusterId={clusterId} objectRef={claim.ref} fromTab="storage" className="bg-transparent px-0 py-0 text-sm" />
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn('size-1.5 rounded-full', style.dot)} />
              {word}
              {(claim.capacity ?? claim.requested) && ` · ${claim.capacity ?? claim.requested}`}
              {claim.accessModes.length > 0 && ` · ${claim.accessModes.map((m) => ACCESS_MODE[m] ?? m).join(', ')}`}
            </p>
          </div>
        </div>
        <ArrowRight size={14} className="shrink-0 text-muted-foreground" aria-hidden />
        {claim.volume ? (
          <div
            className={cn(
              'flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5',
              claim.volume.exists ? 'border-border' : 'border-dashed border-red-500 text-red-600',
            )}
          >
            <HardDrive size={15} className="shrink-0 text-muted-foreground" />
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-medium">{claim.volume.name}</p>
              <p className="text-xs text-muted-foreground">
                {!claim.volume.exists
                  ? 'This volume no longer exists'
                  : claim.volume.reclaimPolicy === 'Retain'
                    ? 'Data kept if the claim is deleted'
                    : claim.volume.reclaimPolicy === 'Delete'
                      ? 'Data deleted with the claim'
                      : 'Volume'}
              </p>
            </div>
          </div>
        ) : (
          <span className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground">
            <Hourglass size={13} /> No volume yet
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          class {claim.storageClass === '' ? 'none (a volume made by hand)' : (claim.storageClass ?? 'default')}
        </span>
      </div>
      <UsedBy
        clusterId={clusterId}
        consumers={claim.usedBy}
        fromTab="storage"
        none="No workload mounts it now — its data stays until the claim is deleted."
      />
      {claim.problem && <DiagnosisCard clusterId={clusterId} diagnosis={claim.problem} fromTab="storage" />}
    </li>
  );
}

function VolumeRow({ clusterId, volume }: { clusterId: string; volume: KubeVolumeItem }) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
      <HardDrive size={14} className="shrink-0 text-muted-foreground" />
      <ObjectChip clusterId={clusterId} objectRef={volume.ref} fromTab="storage" />
      <span className="text-xs text-muted-foreground">
        {[volume.capacity, volume.storageClass && `class ${volume.storageClass}`].filter(Boolean).join(' · ')}
      </span>
      <span className={cn('text-xs', volume.phase === 'Failed' ? 'text-red-600' : 'text-muted-foreground')}>
        — {VOLUME_PHASE[volume.phase] ?? volume.phase}
        {volume.claim && volume.phase === 'Released' && ` (was ${volume.claim.namespace ? `${volume.claim.namespace}/` : ''}${volume.claim.name})`}
      </span>
    </li>
  );
}

export default function StorageTab({ clusterId, namespace }: { clusterId: string; namespace: string }) {
  const ns = namespace || null;
  const key = kubeKeys.storage(clusterId, ns);
  const storage = useQuery<KubeStorageView>({
    queryKey: key,
    queryFn: () => api.get(kubePath(clusterId, `/storage${ns ? `?namespace=${encodeURIComponent(ns)}` : ''}`)),
    retry: false,
  });
  useKubeChanges(clusterId, 'storage', { namespace: ns }, key, storage.isSuccess);

  if (storage.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" /> Reading storage…
      </p>
    );
  }
  if (storage.error) return <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(storage.error as Error).message}</p>;
  const v = storage.data!;
  const problems = v.claims.filter((c) => c.problem).length;
  const waiting = v.claims.filter((c) => c.phase === 'Pending' && !c.problem).length;

  return (
    <div className="space-y-5">
      {v.warnings.map((w) => (
        <p key={w} className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          {w}
        </p>
      ))}

      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-medium">Storage claims</h2>
          <p className="text-xs text-muted-foreground">
            A claim is an app's request for a disk that keeps its data when pods restart.
            {v.claims.length > 0 &&
              ` ${v.claims.length} claim${v.claims.length === 1 ? '' : 's'}${problems ? ` · ${problems} without storage` : ''}${waiting ? ` · ${waiting} waiting` : ''}.`}
          </p>
        </div>
        {v.claims.length ? (
          <ul className="space-y-2" data-testid="storage-claims">
            {v.claims.map((c) => (
              <ClaimRow key={`${c.ref.namespace}/${c.ref.name}`} clusterId={clusterId} claim={c} classes={v.classes} />
            ))}
          </ul>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card px-6 py-10 text-center">
            <Database size={26} className="text-muted-foreground" />
            <p className="max-w-md text-sm text-muted-foreground">
              No storage claims{ns ? ` in ${ns}` : ''}. Apps here keep no data that outlives their pods.
            </p>
          </div>
        )}
      </section>

      {v.classes && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-sm font-medium">Storage classes</h2>
            <p className="text-xs text-muted-foreground">The kinds of disk this cluster can create on demand. A claim that names none gets the default.</p>
          </div>
          {v.classes.length ? (
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid="storage-classes">
              {v.classes.map((c) => (
                <li key={c.name} className="rounded-md border border-border bg-card px-3 py-2 text-sm">
                  <p className="flex items-center gap-2">
                    <Layers size={14} className="text-muted-foreground" />
                    <span className="font-medium">{c.name}</span>
                    {c.isDefault && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">default</span>}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {bindingWords(c.bindingMode)}
                    {c.reclaimPolicy === 'Retain' ? ' · keeps data after a claim is deleted' : c.reclaimPolicy === 'Delete' ? ' · deletes data with the claim' : ''}
                    {` · ${c.claims} claim${c.claims === 1 ? '' : 's'}`}
                  </p>
                  {c.provisioner && <p className="truncate font-mono text-[11px] text-muted-foreground">{c.provisioner}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No storage classes: nothing creates disks on demand, so every claim needs a volume made by hand.
            </p>
          )}
        </section>
      )}

      {!ns && v.volumes.length > 0 && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-sm font-medium">Volumes no claim holds</h2>
            <p className="text-xs text-muted-foreground">Disks that exist but no app is using.</p>
          </div>
          <ul className="space-y-1.5" data-testid="storage-volumes">
            {v.volumes.map((pv) => (
              <VolumeRow key={pv.ref.name} clusterId={clusterId} volume={pv} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
