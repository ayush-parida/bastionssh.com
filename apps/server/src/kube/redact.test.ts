import { describe, it, expect } from 'vitest';
import { REDACTED, redactObject, trimForCache } from './redact.js';

const secret = {
  kind: 'Secret',
  type: 'Opaque',
  metadata: {
    name: 'db',
    namespace: 'shop',
    managedFields: [{ manager: 'kubectl' }],
    annotations: {
      'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"password":"aHVudGVyMg=="}}',
      team: 'payments',
    },
  },
  data: { password: 'aHVudGVyMg==', user: 'YWRtaW4=' },
  stringData: { token: 'plain' },
};

describe('kube redaction', () => {
  it('keeps a Secret’s keys and drops every value and every copy of them', () => {
    const out = redactObject(secret, { showConfigMapValues: true }) as typeof secret;
    expect(out.data).toEqual({ password: REDACTED, user: REDACTED });
    expect(out.stringData).toEqual({ token: REDACTED });
    expect(out.metadata.annotations).toEqual({ team: 'payments' });
    expect(out.metadata.managedFields).toBeUndefined();
    const text = JSON.stringify(out);
    for (const value of ['aHVudGVyMg==', 'YWRtaW4=', 'plain', 'hunter2']) expect(text).not.toContain(value);
    // The input is untouched
    expect(secret.data.password).toBe('aHVudGVyMg==');
  });

  it('redacts Secrets inside lists, even when items leave out their kind', () => {
    const { kind: _kind, ...item } = secret;
    const out = redactObject({ kind: 'SecretList', items: [item] }, { showConfigMapValues: true });
    expect(JSON.stringify(out)).not.toContain('aHVudGVyMg==');
  });

  it('shows ConfigMap values unless the org hides them', () => {
    const cm = { kind: 'ConfigMap', metadata: { name: 'cfg' }, data: { LOG_LEVEL: 'debug' }, binaryData: { blob: 'AAEC' } };
    expect((redactObject(cm, { showConfigMapValues: true }) as typeof cm).data).toEqual({ LOG_LEVEL: 'debug' });
    const hidden = redactObject(cm, { showConfigMapValues: false }) as typeof cm;
    expect(hidden.data).toEqual({ LOG_LEVEL: REDACTED });
    expect(hidden.binaryData).toEqual({ blob: REDACTED });
  });

  it('shows env references to Secrets as references, never resolved', () => {
    const pod = {
      kind: 'Pod',
      metadata: { name: 'web', managedFields: [{}] },
      spec: { containers: [{ name: 'app', env: [{ name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: 'db', key: 'password' } } }] }] },
    };
    const out = redactObject(pod, { showConfigMapValues: true }) as typeof pod & { metadata: { managedFields?: unknown } };
    expect(out.spec.containers[0]!.env[0]).toEqual({ name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: 'db', key: 'password' } } });
    expect(out.metadata.managedFields).toBeUndefined();
  });

  it('never stores Secret values in the cache', () => {
    expect(JSON.stringify(trimForCache(secret))).not.toContain('aHVudGVyMg==');
  });
});
