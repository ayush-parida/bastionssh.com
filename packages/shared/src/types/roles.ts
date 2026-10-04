/**
 * Custom roles and per-resource access (custom roles spec §2–§5).
 *
 * Every member keeps a base role (viewer < operator < admin < owner) and a
 * scope: `all` applies the base role to every resource, `roles` limits them
 * to what their custom roles and personal grants cover. A resource's
 * effective level is the highest of the base level (scope `all` only), every
 * role grant and every personal grant that covers it. Owners and admins
 * always have `manage` everywhere; roles never grant org-admin features.
 */

/** The resource types access can be granted on. */
export type ResourceType =
  | 'server'
  | 'cluster'
  | 'ftp_connection'
  | 'storage_connection'
  | 'cloud_account'
  | 'saved_command'
  | 'cron_job';

export const RESOURCE_TYPES: readonly ResourceType[] = [
  'server',
  'cluster',
  'ftp_connection',
  'storage_connection',
  'cloud_account',
  'saved_command',
  'cron_job',
];

/** Ordered least- to most-privileged; each level implies the ones before it. */
export type AccessLevel = 'view' | 'operate' | 'manage';

export const ACCESS_LEVELS: readonly AccessLevel[] = ['view', 'operate', 'manage'];

/** `all`: the base role applies to every resource. `roles`: only what roles and personal grants cover. */
export type MemberScope = 'all' | 'roles';

/** What a grant targets: one resource, every resource of its type, or (servers only) every server with a tag. */
export type GrantSelector = 'id' | 'all' | 'tag';

/** Who a grant is for: a custom role (its members) or one user (a personal grant). */
export type GrantPrincipal = 'role' | 'user';

/** One entry of a role's (or a member's personal) resource list. */
export interface RoleGrant {
  id: string;
  resourceType: ResourceType;
  selector: GrantSelector;
  /** Set when `selector` is `id`. */
  resourceId: string | null;
  /** Set when `selector` is `tag` (servers only). */
  tag: string | null;
  /** Clusters only: the namespaces covered; null = every namespace. */
  namespaces: string[] | null;
  level: AccessLevel;
  /** Null = permanent. */
  expiresAt: string | null;
  grantedBy: string | null;
  reason: string | null;
  createdAt: string;
}

/**
 * A named custom role. Called `CustomRole` because `Role` is the base role
 * (types/auth.ts).
 */
export interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  memberCount?: number;
  grants?: RoleGrant[];
}

/** A member of a custom role; `expiresAt` null = permanent. */
export interface RoleMember {
  roleId: string;
  userId: string;
  expiresAt: string | null;
  addedBy: string | null;
  addedAt: string;
}

/** Where a level on a resource comes from. */
export interface AccessReason {
  /** `base`: the member's base role (scope `all`, or admin/owner). `role`: a custom role. `grant`: a personal grant. */
  kind: 'base' | 'role' | 'grant';
  /** The base role, the custom role's name, or `personal`. */
  name: string;
  level: AccessLevel;
  roleId?: string;
  grantId?: string;
  selector?: GrantSelector;
  tag?: string;
  /** Clusters only; null/absent = every namespace. */
  namespaces?: string[] | null;
  /** When the role membership or grant ends; null/absent = permanent. */
  expiresAt?: string | null;
}

/** A member's effective access to one resource. `level` null = no access. */
export interface EffectiveAccess {
  resourceType: ResourceType;
  resourceId: string;
  level: AccessLevel | null;
  /** Every reason that applies, highest level first. */
  via: AccessReason[];
  /** Clusters only: namespaces the member may see; null = every namespace. */
  namespaces?: string[] | null;
}
