/**
 * The authorization engine for custom roles and per-resource access (custom
 * roles spec §4). One place decides what a member may see and do on each
 * resource; auth/server-access.ts and auth/cluster-access.ts wrap it for
 * their existing call sites.
 *
 * - levels.ts — level order, base role → level, action → required level (§5)
 * - resolve.ts — a member's membership, roles and grants, loaded once per request
 * - authorize.ts — `levelFor`, `authorize` (404 / 403), `requireResource` preHandler
 * - filter.ts — `accessibleFilter` (SQL), `accessibleIds`, `filterAccessible` (in memory)
 * - explain.ts — why a member has the level they have
 * - revoke.ts — `revokeAfterChange`: close what a change took away
 * - effective.ts — every resource of a type with the subject's level on it
 * - grants.ts — reading and replacing a role's or a member's grant list
 */
export * from './levels.js';
export { resolveAccess, forgetAccess, subjectOf, type AccessSubject, type ResolvedAccess } from './resolve.js';
export { authorize, levelFor, requireResource, type AuthorizeResult, type ResourceLevel } from './authorize.js';
export { accessibleFilter, accessibleIds, filterAccessible, resourceExists, type AccessibleIds } from './filter.js';
export { explain, explainFor } from './explain.js';
export { effectiveAccessList, listResources } from './effective.js';
export {
  addPersonalGrant,
  draftGrants,
  grantsOfRoles,
  principalGrants,
  replaceGrants,
  toRoleGrant,
  type GrantDraft,
} from './grants.js';
export {
  accessSnapshot,
  keepSets,
  lostAccess,
  revokeAfterChange,
  snapshotAccess,
  type AccessSnapshot,
} from './revoke.js';
