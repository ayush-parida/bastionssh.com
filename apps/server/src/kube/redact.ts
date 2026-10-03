/**
 * Secret values never leave the server (spec §2.8, §8.4). Everything an
 * object goes through before a browser, the AI or a log sees it passes here:
 *
 * - `Secret`: `data` and `stringData` keep their keys, every value becomes
 *   {@link REDACTED}; the last-applied annotation (which holds the whole
 *   manifest, values included) is dropped.
 * - Containers: `env` entries keep `valueFrom` references (`secretKeyRef`
 *   shows which Secret and key, not the value); literal `value`s are shown,
 *   as Kubernetes itself does in `describe`.
 * - `ConfigMap`: values shown unless the org turned `showConfigMapValues` off.
 * - Every object: `metadata.managedFields` stripped (noise, and large).
 *
 * The functions return new objects; their input is not modified.
 */

export const REDACTED = '••••';

/** Annotations that copy an object's full manifest — for a Secret, its values. */
const MANIFEST_ANNOTATIONS = ['kubectl.kubernetes.io/last-applied-configuration'];

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function maskValues(map: unknown): unknown {
  if (!isObject(map)) return map;
  return Object.fromEntries(Object.keys(map).map((key) => [key, REDACTED]));
}

/** `metadata` without managedFields, and without manifest-copying annotations when `dropManifest`. */
function cleanMetadata(metadata: unknown, dropManifest: boolean): unknown {
  if (!isObject(metadata)) return metadata;
  const { managedFields: _managed, ...rest } = metadata;
  if (dropManifest && isObject(rest.annotations)) {
    const annotations = { ...rest.annotations };
    for (const key of MANIFEST_ANNOTATIONS) delete annotations[key];
    rest.annotations = annotations;
  }
  return rest;
}

/** A Secret with its values masked and nothing that could carry them. */
export function redactSecret(secret: Json): Json {
  return {
    ...secret,
    metadata: cleanMetadata(secret.metadata, true),
    ...('data' in secret && { data: maskValues(secret.data) }),
    ...('stringData' in secret && { stringData: maskValues(secret.stringData) }),
  };
}

/** A ConfigMap, its values masked when the org hides them. */
export function redactConfigMap(configMap: Json, showValues: boolean): Json {
  if (showValues) return { ...configMap, metadata: cleanMetadata(configMap.metadata, false) };
  return {
    ...configMap,
    metadata: cleanMetadata(configMap.metadata, true),
    ...('data' in configMap && { data: maskValues(configMap.data) }),
    ...('binaryData' in configMap && { binaryData: maskValues(configMap.binaryData) }),
  };
}

export interface RedactOptions {
  /** The org's `showConfigMapValues`. */
  showConfigMapValues: boolean;
}

/**
 * Any object, ready to leave the server. Unknown kinds only lose
 * managedFields; Secrets and ConfigMaps are handled by kind, also inside a
 * `List`, so nothing slips through as an item.
 */
export function redactObject<T>(object: T, opts: RedactOptions): T {
  if (!isObject(object)) return object;
  const kind = object.kind;
  if (kind === 'Secret') return redactSecret(object) as T;
  if (kind === 'ConfigMap') return redactConfigMap(object, opts.showConfigMapValues) as T;
  if (typeof kind === 'string' && kind.endsWith('List') && Array.isArray(object.items)) {
    const itemKind = kind.slice(0, -'List'.length);
    return {
      ...object,
      items: object.items.map((item: unknown) =>
        // List items often omit their own kind
        redactObject(isObject(item) && !item.kind && itemKind ? { kind: itemKind, ...item } : item, opts),
      ),
    } as T;
  }
  return { ...object, metadata: cleanMetadata(object.metadata, false) } as T;
}

/**
 * Trim an object for the watch cache: managedFields go (they are often half
 * of a pod's size), and a Secret is stored already redacted, so its values
 * never sit in memory here at all.
 */
export function trimForCache(object: Json): Json {
  if (object.kind === 'Secret') return redactSecret(object);
  return { ...object, metadata: cleanMetadata(object.metadata, false) };
}
