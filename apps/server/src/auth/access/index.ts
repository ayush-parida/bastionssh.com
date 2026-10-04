/**
 * The authorization engine for unified roles, module permissions and
 * per-resource access (unified roles spec §4, custom roles spec §4). One
 * place decides what a member may use and do on each module and resource;
 * auth/server-access.ts and auth/cluster-access.ts wrap it for their
 * existing call sites.
 *
 * - levels.ts — level order, action → required level (§5), module levels
 * - resolve.ts — a member's roles, module levels and grants, loaded once per request
 * - modules.ts — `requireModule`, `moduleLevel`, `visibleModules`, owner-only, the delegation guard
 * - authorize.ts — `levelFor`, `authorize` (404 / 403), `requireResource` preHandler
 * - filter.ts — `accessibleFilter` (SQL), `accessibleIds`, `filterAccessible` (in memory)
 * - explain.ts — why a member has the level they have
 * - revoke.ts — `revokeAfterChange`: close what a change took away
 * - effective.ts — every resource of a type with the subject's level on it
 * - grants.ts — reading and replacing a role's or a member's grant list
 */
export * from './levels.js';
export {
  resolveAccess,
  forgetAccess,
  subjectOf,
  type AccessSubject,
  type HeldRoleInfo,
  type ResolvedAccess,
} from './resolve.js';
export {
  accessSummary,
  canAssignRole,
  canGrant,
  customRoleFilter,
  hasModule,
  isOrgOwner,
  isOwner,
  moduleLevel,
  requireModule,
  requireOwner,
  RESERVED_ROLE_NAMES,
  rolePermissions,
  visibleModules,
  type DelegationResult,
} from './modules.js';
export { authorize, levelFor, requireResource, type AuthorizeResult, type ResourceLevel } from './authorize.js';
export { accessibleFilter, accessibleIds, filterAccessible, reachesAny, resourceExists, type AccessibleIds } from './filter.js';
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
