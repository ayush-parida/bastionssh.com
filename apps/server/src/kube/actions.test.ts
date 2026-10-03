import { describe, it, expect } from 'vitest';
import { kubeActionCommand } from '@smt/shared';
import type { KubeClient, KubeObject } from './client.js';
import { KubeError } from './errors.js';
import {
  INSTANTIATE_ANNOTATION,
  RESTARTED_AT_ANNOTATION,
  cordonPatch,
  jobFromCronJob,
  manualJobName,
  podIsRecreated,
  restartPatch,
  rollbackDeployment,
  rollbackAnnotations,
  rollbackPatch,
  sameTemplate,
  scalePatch,
  suspendPatch,
  templateContainers,
  templateWithoutHash,
  toRevisions,
  updateStrategy,
} from './actions.js';
import { isDns1123Subdomain } from './validation.js';

/** The guided actions' patch bodies (spec §6) and the helpers around them, without a cluster. */

const template = (image: string, env: Record<string, string> = {}, hash?: string) => ({
  metadata: { labels: { app: 'web', ...(hash && { 'pod-template-hash': hash }) } },
  spec: {
    containers: [
      {
        name: 'app',
        image,
        env: Object.entries(env).map(([name, value]) => ({ name, value })),
      },
    ],
  },
});

const deployment: KubeObject = {
  kind: 'Deployment',
  metadata: {
    name: 'web',
    namespace: 'shop',
    uid: 'dep-uid',
    resourceVersion: '812',
    annotations: {
      'deployment.kubernetes.io/revision': '3',
      'kubectl.kubernetes.io/last-applied-configuration': '{"keep":"me"}',
      'team/owner': 'payments',
    },
  },
  spec: { selector: { matchLabels: { app: 'web' } }, template: template('shop/web:1.3', { LOG_LEVEL: 'debug', NEW_FLAG: '1' }) },
};

const rs = (revision: number, image: string, env: Record<string, string> = {}, extra: Record<string, string> = {}): KubeObject => ({
  kind: 'ReplicaSet',
  metadata: {
    name: `web-${revision}abc`,
    namespace: 'shop',
    creationTimestamp: `2026-10-0${revision}T00:00:00Z`,
    annotations: { 'deployment.kubernetes.io/revision': String(revision), ...extra },
    ownerReferences: [{ kind: 'Deployment', name: 'web', uid: 'dep-uid', controller: true }],
  },
  spec: { template: template(image, env, `hash${revision}`) },
  status: { replicas: revision === 3 ? 2 : 0 },
});

describe('patch bodies', () => {
  it('scale sets spec.replicas (for the scale subresource)', () => {
    expect(scalePatch(5)).toEqual({ spec: { replicas: 5 } });
    expect(scalePatch(0)).toEqual({ spec: { replicas: 0 } });
  });

  it('restart sets the restartedAt annotation on the pod template, as kubectl does', () => {
    const at = new Date('2026-10-03T12:00:00.000Z');
    expect(restartPatch(at)).toEqual({
      spec: { template: { metadata: { annotations: { [RESTARTED_AT_ANNOTATION]: '2026-10-03T12:00:00.000Z' } } } },
    });
    expect(RESTARTED_AT_ANNOTATION).toBe('kubectl.kubernetes.io/restartedAt');
  });

  it('cordon and uncordon set spec.unschedulable; suspend sets spec.suspend', () => {
    expect(cordonPatch(true)).toEqual({ spec: { unschedulable: true } });
    expect(cordonPatch(false)).toEqual({ spec: { unschedulable: false } });
    expect(suspendPatch(true)).toEqual({ spec: { suspend: true } });
    expect(suspendPatch(false)).toEqual({ spec: { suspend: false } });
  });
});

describe('rollback', () => {
  it('copies the ReplicaSet template without its pod-template-hash label, guarded by the resourceVersion', () => {
    const target = rs(1, 'shop/web:1.1', { LOG_LEVEL: 'info' }, { 'kubernetes.io/change-cause': 'first release' });
    const ops = rollbackPatch(deployment, target);
    expect(ops[0]).toEqual({ op: 'test', path: '/metadata/resourceVersion', value: '812' });
    expect(ops[1]).toEqual({ op: 'replace', path: '/spec/template', value: template('shop/web:1.1', { LOG_LEVEL: 'info' }) });
    expect(JSON.stringify(ops)).not.toContain('pod-template-hash');
    expect(ops[2]!.op).toBe('add');
    expect(ops[2]!.path).toBe('/metadata/annotations');
  });

  it('takes annotations from the ReplicaSet but keeps the Deployment’s revision and last-applied ones (kubectl’s skip list)', () => {
    const target = rs(1, 'shop/web:1.1', {}, { 'kubernetes.io/change-cause': 'first release' });
    expect(rollbackAnnotations(deployment, target)).toEqual({
      'deployment.kubernetes.io/revision': '3',
      'kubectl.kubernetes.io/last-applied-configuration': '{"keep":"me"}',
      'kubernetes.io/change-cause': 'first release',
    });
  });

  it('does not modify the ReplicaSet it copies from', () => {
    const target = rs(1, 'shop/web:1.1');
    templateWithoutHash(target.spec!.template);
    expect((target.spec!.template as { metadata: { labels: Record<string, string> } }).metadata.labels['pod-template-hash']).toBe('hash1');
  });

  it('compares templates ignoring the hash label and key order', () => {
    expect(sameTemplate(template('a:1', {}, 'x'), template('a:1'))).toBe(true);
    expect(sameTemplate({ spec: { b: 1, a: 2 } }, { spec: { a: 2, b: 1 } })).toBe(true);
    expect(sameTemplate(template('a:1'), template('a:2'))).toBe(false);
  });

  it('lists revisions newest first with images and env names only, marking the current one', () => {
    const revisions = toRevisions(deployment, [rs(3, 'shop/web:1.3', { LOG_LEVEL: 'debug', NEW_FLAG: '1' }), rs(1, 'shop/web:1.1', { LOG_LEVEL: 'info' })]);
    expect(revisions.map((r) => [r.revision, r.current, r.replicas])).toEqual([
      [3, true, 2],
      [1, false, 0],
    ]);
    expect(revisions[1]!.containers).toEqual([{ name: 'app', image: 'shop/web:1.1', envNames: ['LOG_LEVEL'] }]);
    // Names only: no env value reaches the revision list
    expect(JSON.stringify(revisions)).not.toContain('debug');
    expect(JSON.stringify(revisions)).not.toContain('"info"');
  });

  it('reads containers with init containers first, never env values', () => {
    const containers = templateContainers({
      spec: {
        initContainers: [{ name: 'migrate', image: 'm:1', env: [{ name: 'DB', valueFrom: { secretKeyRef: { name: 's', key: 'k' } } }] }],
        containers: [{ name: 'app', image: 'a:1', env: [{ name: 'TOKEN', value: 'hunter2' }] }],
      },
    });
    expect(containers).toEqual([
      { name: 'migrate', image: 'm:1', envNames: ['DB'] },
      { name: 'app', image: 'a:1', envNames: ['TOKEN'] },
    ]);
    expect(JSON.stringify(containers)).not.toContain('hunter2');
  });
});

describe('rollback against a Deployment that changes meanwhile', () => {
  // A stub client: the Deployment's resourceVersion moves on after the first read, and the API server refuses the guarded patch as it does (a bare 422)
  function racingClient(): KubeClient {
    let reads = 0;
    return {
      get: async () => structuredClone({ ...deployment, metadata: { ...deployment.metadata, resourceVersion: ++reads === 1 ? '812' : '813' } }),
      list: async () => ({ items: [rs(2, 'shop/web:1.2'), rs(3, 'shop/web:1.3', { LOG_LEVEL: 'debug', NEW_FLAG: '1' })] }),
      patch: async () => {
        throw new KubeError('the server rejected our request due to an error in our request', 422, 'Invalid');
      },
    } as unknown as KubeClient;
  }

  it('answers 409 with what happened instead of the API server’s bare 422', async () => {
    const err = await rollbackDeployment(racingClient(), { namespace: 'shop', name: 'web', revision: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KubeError);
    expect((err as KubeError).statusCode).toBe(409);
    expect((err as KubeError).message).toMatch(/changed while it was being rolled back/);
  });

  it('passes a 422 through when the Deployment did not change (an invalid template)', async () => {
    const client = racingClient();
    (client as unknown as { get: () => Promise<KubeObject> }).get = async () => structuredClone(deployment);
    const err = await rollbackDeployment(client, { namespace: 'shop', name: 'web', revision: 2 }).catch((e: unknown) => e);
    expect((err as KubeError).statusCode).toBe(422);
  });
});

describe('what a change does to the pods', () => {
  it('reads the update strategy, with the API defaults when unset', () => {
    const w = (spec: Record<string, unknown>): KubeObject => ({ metadata: { name: 'x' }, spec });
    expect(updateStrategy('Deployment', w({}))).toBe('RollingUpdate');
    expect(updateStrategy('Deployment', w({ strategy: { type: 'Recreate' } }))).toBe('Recreate');
    expect(updateStrategy('StatefulSet', w({ updateStrategy: { type: 'OnDelete' } }))).toBe('OnDelete');
    expect(updateStrategy('DaemonSet', w({ updateStrategy: { type: 'RollingUpdate' } }))).toBe('RollingUpdate');
    // A Deployment has no OnDelete; its updateStrategy field is not its strategy
    expect(updateStrategy('Deployment', w({ updateStrategy: { type: 'OnDelete' } }))).toBe('RollingUpdate');
  });

  it('knows which deleted pods come back', () => {
    const p = (owner: string | null, phase: string): KubeObject => ({
      metadata: { name: 'p', ...(owner && { ownerReferences: [{ kind: owner, name: 'o', controller: true }] }) },
      status: { phase },
    });
    expect(podIsRecreated(p('ReplicaSet', 'Running'))).toBe(true);
    expect(podIsRecreated(p('Job', 'Running'))).toBe(true);
    expect(podIsRecreated(p('Job', 'Succeeded'))).toBe(false);
    expect(podIsRecreated(p('Job', 'Failed'))).toBe(false);
    expect(podIsRecreated(p(null, 'Running'))).toBe(false);
  });
});

describe('CronJob trigger', () => {
  const cronJob: KubeObject = {
    kind: 'CronJob',
    metadata: { name: 'nightly-report', namespace: 'shop', uid: 'cron-uid' },
    spec: {
      schedule: '0 3 * * *',
      jobTemplate: {
        metadata: { labels: { team: 'data' }, annotations: { note: 'x' } },
        spec: { backoffLimit: 1, template: { spec: { restartPolicy: 'Never', containers: [{ name: 'r', image: 'report:1' }] } } },
      },
    },
  };

  it('creates a Job from the job template, owned by the CronJob and marked manual', () => {
    const job = jobFromCronJob(cronJob, 'nightly-report-manual-abc12');
    expect(job).toEqual({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: 'nightly-report-manual-abc12',
        namespace: 'shop',
        labels: { team: 'data' },
        annotations: { note: 'x', [INSTANTIATE_ANNOTATION]: 'manual' },
        ownerReferences: [
          { apiVersion: 'batch/v1', kind: 'CronJob', name: 'nightly-report', uid: 'cron-uid', controller: true, blockOwnerDeletion: true },
        ],
      },
      spec: (cronJob.spec as { jobTemplate: { spec: unknown } }).jobTemplate.spec,
    });
  });

  it('generates a valid name of at most 63 characters', () => {
    expect(manualJobName('nightly', 'abc12')).toBe('nightly-manual-abc12');
    const long = manualJobName('a'.repeat(49) + '-b', 'zz999');
    expect(long.length).toBeLessThanOrEqual(63);
    expect(isDns1123Subdomain(long)).toBe(true);
    expect(long).not.toContain('--');
    const random = manualJobName('x'.repeat(52));
    expect(random).toMatch(/^x+-manual-[a-z0-9]{5}$/);
    expect(random.length).toBeLessThanOrEqual(63);
    expect(manualJobName('nightly')).not.toBe(manualJobName('nightly'));
  });
});

describe('equivalent kubectl commands (display only)', () => {
  const dep = { kind: 'Deployment', namespace: 'shop', name: 'web' };
  it('names each action as kubectl would', () => {
    expect(kubeActionCommand('scale', dep, { replicas: 3 })).toBe('kubectl scale deployment/web --replicas=3 -n shop');
    expect(kubeActionCommand('restart', dep)).toBe('kubectl rollout restart deployment/web -n shop');
    expect(kubeActionCommand('rollback', dep, { revision: 4 })).toBe('kubectl rollout undo deployment/web --to-revision=4 -n shop');
    expect(kubeActionCommand('delete-pod', { kind: 'Pod', namespace: 'shop', name: 'web-1' })).toBe('kubectl delete pod web-1 -n shop');
    expect(kubeActionCommand('cordon', { kind: 'Node', namespace: null, name: 'worker-1' })).toBe('kubectl cordon worker-1');
    expect(kubeActionCommand('uncordon', { kind: 'Node', namespace: null, name: 'worker-1' })).toBe('kubectl uncordon worker-1');
    const cron = { kind: 'CronJob', namespace: 'shop', name: 'nightly' };
    expect(kubeActionCommand('suspend-cronjob', cron, { suspend: true })).toBe(`kubectl patch cronjob/nightly -n shop -p '{"spec":{"suspend":true}}'`);
    expect(kubeActionCommand('trigger-cronjob', cron, { jobName: 'nightly-manual-ab12c' })).toBe(
      'kubectl create job nightly-manual-ab12c --from=cronjob/nightly -n shop',
    );
  });
});
