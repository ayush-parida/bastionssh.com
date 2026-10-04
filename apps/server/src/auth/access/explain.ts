import type { EffectiveAccess, ResourceType } from '@smt/shared';
import { levelFor } from './authorize.js';
import type { AccessSubject } from './resolve.js';

/**
 * "Why does alice have access to web-1?" (spec §4 explain.ts) — the level and
 * every reason behind it: the base role, each custom role (with the selector
 * that matched: the id, "all", or a tag) and each personal grant, with their
 * expiry. Used by the member detail, the access checker and who-has-access.
 * A resource the member cannot reach, or that is not in the org, comes back
 * with a null level and no reasons.
 */
export function explain(
  who: AccessSubject,
  type: ResourceType,
  resourceId: string,
  opts: { namespace?: string } = {},
): EffectiveAccess {
  const found = levelFor(who, type, resourceId, opts);
  const result: EffectiveAccess = {
    resourceType: type,
    resourceId,
    level: found?.level ?? null,
    via: found?.via ?? [],
  };
  if (type === 'cluster') result.namespaces = found ? found.namespaces : [];
  return result;
}

/** `explain` for any member of `orgId`, as an admin's access checker asks it. */
export function explainFor(orgId: string, userId: string, type: ResourceType, resourceId: string): EffectiveAccess {
  return explain({ orgId, userId }, type, resourceId);
}
