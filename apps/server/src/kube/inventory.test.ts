import { describe, it, expect } from 'vitest';
import type { KubeObject } from './client.js';
import { buildConfigView, buildStorageView, consumersOf } from './inventory.js';

/** The Storage and Config tabs' builders: who uses what, missing references, and nothing but key names. */

const cronJob: KubeObject = {
  kind: 'CronJob',
  metadata: { name: 'report', namespace: 'shop' },
  spec: {
    jobTemplate: {
      spec: { template: { spec: { containers: [{ name: 'r', envFrom: [{ configMapRef: { name: 'report-cfg' } }] }] } } },
    },
  },
};
const cronRun: KubeObject = {
  kind: 'Job',
  metadata: { name: 'report-1', namespace: 'shop', ownerReferences: [{ kind: 'CronJob', name: 'report', controller: true }] },
  spec: { template: { spec: { containers: [{ name: 'r', envFrom: [{ configMapRef: { name: 'report-cfg' } }] }] } } },
};
const barePod: KubeObject = {
  kind: 'Pod',
  metadata: { name: 'debug', namespace: 'shop' },
  spec: {
    containers: [
      {
        name: 'sh',
        env: [{ name: 'TOKEN', valueFrom: { secretKeyRef: { name: 'api-token', key: 'token' } } }],
        envFrom: [{ configMapRef: { name: 'maybe', optional: true } }],
      },
    ],
    volumes: [{ name: 'cfg', configMap: { name: 'report-cfg' } }],
  },
};

describe('consumersOf', () => {
  it("counts a CronJob's runs once, on the CronJob, and a bare pod as itself", () => {
    const { usedBy, required } = consumersOf({ cronjobs: [cronJob], jobs: [cronRun], pods: [barePod] });
    expect(usedBy.get('ConfigMap/shop/report-cfg')).toEqual([
      { ref: expect.objectContaining({ kind: 'CronJob', name: 'report' }), how: ['env'] },
      { ref: expect.objectContaining({ kind: 'Pod', name: 'debug' }), how: ['mounts'] },
    ]);
    expect(required.has('ConfigMap/shop/maybe')).toBe(false);
    expect(required.has('Secret/shop/api-token')).toBe(true);
  });
});

describe('buildConfigView', () => {
  it('lists key names only and calls out required references that do not exist', () => {
    const v = buildConfigView({
      cronjobs: [cronJob],
      jobs: [cronRun],
      pods: [barePod],
      configmaps: [{ kind: 'ConfigMap', metadata: { name: 'report-cfg', namespace: 'shop' }, data: { B: 'secret-ish', A: 'x' } }],
      secrets: [],
    });
    expect(v.configMaps[0]).toMatchObject({ keys: ['A', 'B'], type: null });
    expect(JSON.stringify(v)).not.toContain('secret-ish');
    // The optional ConfigMap is not missing; the Secret is
    expect(v.missing).toEqual([{ kind: 'Secret', namespace: 'shop', name: 'api-token', usedBy: [expect.objectContaining({ how: ['env'] })] }]);
  });

  it('never calls something missing when its kind could not be listed', () => {
    const v = buildConfigView({ pods: [barePod], configmaps: null, secrets: null });
    expect(v.missing).toEqual([]);
  });
});

describe('buildStorageView', () => {
  const claim = (name: string, spec: Record<string, unknown>, phase = 'Bound'): KubeObject => ({
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace: 'shop' },
    spec,
    status: { phase },
  });

  it('does not call a volume missing when volumes could not be listed', () => {
    const v = buildStorageView({ persistentvolumeclaims: [claim('a', { volumeName: 'pv-a' })], persistentvolumes: null, storageclasses: null });
    expect(v.claims[0]!.volume).toEqual({ name: 'pv-a', phase: null, reclaimPolicy: null, exists: true });
    expect(v.classes).toBeNull();
  });

  it('flags a bound volume that no longer exists', () => {
    const v = buildStorageView({ persistentvolumeclaims: [claim('a', { volumeName: 'pv-a' })], persistentvolumes: [], storageclasses: [] });
    expect(v.claims[0]!.volume?.exists).toBe(false);
  });

  it('leaves a claim waiting for its first pod without a problem', () => {
    const v = buildStorageView({
      persistentvolumeclaims: [claim('later', { storageClassName: 'local' }, 'Pending')],
      persistentvolumes: [],
      storageclasses: [{ kind: 'StorageClass', metadata: { name: 'local' }, volumeBindingMode: 'WaitForFirstConsumer' }],
    });
    expect(v.claims[0]!.problem).toBeNull();
    expect(v.classes).toEqual([expect.objectContaining({ name: 'local', isDefault: false, claims: 1 })]);
  });
});
