import { describe, it, expect } from 'vitest';
import { kubeObjectPath, kubeObjectUrl } from '@smt/shared';
import { isDns1123Label, isDns1123Subdomain, namespaceName, objectName, objectRef, resourceName, resourcePath } from './validation.js';
import { KubeError } from './errors.js';

describe('kube validation', () => {
  it('follows the DNS-1123 rules', () => {
    for (const ok of ['default', 'kube-system', 'a', 'a1-b2']) expect(isDns1123Label(ok)).toBe(true);
    for (const bad of ['', 'Default', '-a', 'a-', 'a_b', 'a.b', 'x'.repeat(64)]) expect(isDns1123Label(bad)).toBe(false);
    for (const ok of ['web-7d4b9c-x2x9z', 'coredns.v1', 'a.b.c']) expect(isDns1123Subdomain(ok)).toBe(true);
    for (const bad of ['..', 'a..b', '.a', 'A', 'a/b', '%2e%2e', 'x'.repeat(254)]) expect(isDns1123Subdomain(bad)).toBe(false);
  });

  it('refuses anything that could escape its URL segment', () => {
    expect(() => namespaceName('../secrets')).toThrow(KubeError);
    expect(() => objectName('web/../../secrets')).toThrow(KubeError);
    expect(() => objectName('web?watch=1')).toThrow(KubeError);
    // Node names on some clouds carry capitals
    expect(objectName('ip-10-0-0-1.EC2.internal', 'nodes')).toBe('ip-10-0-0-1.EC2.internal');
    expect(() => objectName('ip-10-0-0-1.EC2.internal', 'pods')).toThrow(KubeError);
  });

  it('allows only resources from the allowlist', () => {
    expect(resourceName('deployments')).toBe('deployments');
    for (const bad of ['customresourcedefinitions', 'clusterroles', 'Pods', '__proto__', 'constructor']) {
      expect(() => resourceName(bad)).toThrow(/Unknown or unsupported/);
    }
  });

  it('builds object refs with `_` for cluster-scoped objects', () => {
    expect(objectRef('pods', 'shop', 'web-1')).toEqual({ resource: 'pods', namespace: 'shop', name: 'web-1' });
    expect(objectRef('nodes', '_', 'node-1')).toEqual({ resource: 'nodes', namespace: null, name: 'node-1' });
    expect(() => objectRef('nodes', 'default', 'node-1')).toThrow(/not namespaced/);
    expect(() => objectRef('pods', '_', 'web-1')).toThrow(/Invalid namespace/);
  });

  it('builds API paths per group and version', () => {
    expect(resourcePath('pods', { namespace: 'shop', name: 'web-1' })).toBe('/api/v1/namespaces/shop/pods/web-1');
    expect(resourcePath('deployments', { namespace: 'shop', name: 'web', subresource: 'scale' })).toBe(
      '/apis/apps/v1/namespaces/shop/deployments/web/scale',
    );
    expect(resourcePath('nodes', { namespace: 'ignored' })).toBe('/api/v1/nodes');
    expect(resourcePath('ingresses')).toBe('/apis/networking.k8s.io/v1/ingresses');
    expect(resourcePath('horizontalpodautoscalers', { namespace: 'a' })).toBe('/apis/autoscaling/v2/namespaces/a/horizontalpodautoscalers');
  });

  it('gives every object one stable URL in the web app', () => {
    expect(kubeObjectPath({ resource: 'pods', namespace: 'shop', name: 'web-1' })).toBe('objects/pods/shop/web-1');
    expect(kubeObjectUrl('c1', { resource: 'nodes', namespace: null, name: 'node-1' })).toBe('/kubernetes/c1/objects/nodes/_/node-1');
  });
});
