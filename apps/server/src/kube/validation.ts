import { isKubeResource, KUBE_CLUSTER_SCOPE, KUBE_RESOURCES, type KubeResource } from '@smt/shared';
import { KubeError } from './errors.js';

/**
 * Checks for everything a client hands us that ends up in an API server URL
 * (spec §8.5): resources from a fixed allowlist, names and namespaces by
 * Kubernetes' own DNS rules. Segments are also `encodeURIComponent`-ed when
 * the path is built; these checks keep nonsense and traversal out before
 * that and answer 400 with what was wrong.
 */

/** RFC 1123 label: namespaces, and the names of most objects that must be DNS labels (services). */
export const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** RFC 1123 subdomain: object names (pods, deployments, configmaps, nodes…). */
export const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export function isDns1123Label(value: string): boolean {
  return typeof value === 'string' && value.length <= 63 && DNS1123_LABEL.test(value);
}

export function isDns1123Subdomain(value: string): boolean {
  return typeof value === 'string' && value.length <= 253 && DNS1123_SUBDOMAIN.test(value);
}

/**
 * Some objects allow more than a subdomain (node names with capitals on some
 * clouds, RBAC names with colons). Path-safe and bounded is what matters here.
 */
const LOOSE_NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.:]*[A-Za-z0-9])?$/;

/** A namespace. */
export function namespaceName(value: unknown): string {
  if (typeof value !== 'string' || !isDns1123Label(value)) throw new KubeError('Invalid namespace', 400);
  return value;
}

/** An object name: a DNS subdomain, or for nodes the looser form clouds use. */
export function objectName(value: unknown, resource?: KubeResource): string {
  const ok =
    typeof value === 'string' &&
    (isDns1123Subdomain(value) || (resource === 'nodes' && value.length <= 253 && LOOSE_NAME.test(value)));
  if (!ok) throw new KubeError('Invalid object name', 400);
  return value as string;
}

/** A resource from the allowlist. */
export function resourceName(value: unknown): KubeResource {
  if (typeof value !== 'string' || !isKubeResource(value)) throw new KubeError('Unknown or unsupported resource', 400);
  return value;
}

/**
 * The object an `objects/:resource/:namespace/:name` path names, validated:
 * cluster-scoped resources take `_` for the namespace, namespaced ones a real one.
 */
export function objectRef(resource: unknown, namespace: unknown, name: unknown) {
  const r = resourceName(resource);
  const info = KUBE_RESOURCES[r];
  if (info.namespaced) {
    return { resource: r, namespace: namespaceName(namespace), name: objectName(name, r) };
  }
  if (namespace !== KUBE_CLUSTER_SCOPE) throw new KubeError(`${info.kind} objects are not namespaced; use ${KUBE_CLUSTER_SCOPE}`, 400);
  return { resource: r, namespace: null, name: objectName(name, r) };
}

/**
 * The API path of a collection or object: `/api/v1/namespaces/shop/pods/web-1`,
 * `/apis/apps/v1/deployments`. Every segment is encoded.
 */
export function resourcePath(
  resource: KubeResource,
  opts: { namespace?: string | null; name?: string; subresource?: string } = {},
): string {
  const info = KUBE_RESOURCES[resource];
  const base = info.group ? `/apis/${info.group}/${info.version}` : `/api/${info.version}`;
  const segments: string[] = [];
  if (info.namespaced && opts.namespace) segments.push('namespaces', opts.namespace);
  segments.push(resource);
  if (opts.name) segments.push(opts.name);
  if (opts.subresource) segments.push(opts.subresource);
  return `${base}/${segments.map(encodeURIComponent).join('/')}`;
}
