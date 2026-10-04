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
  /**
   * Unified roles (spec §5), from `GET /team/roles`: the built-in role this
   * is (null for every other role).
   */
  system?: BuiltInRole | null;
  /** The role's module levels; a module left out is `none`. */
  modulePermissions?: ModulePermissions;
  /** False for Owner and No access, which are locked. */
  editable?: boolean;
  /** One of the "<Base> (modules only)" roles migration 0025 generated. */
  generated?: boolean;
  /** Built-in roles: changed from their defaults ("Reset to default" puts them back). */
  customized?: boolean;
  /** The caller may give this role to someone, or take it away (the delegation guard, spec §4.2). */
  assignable?: boolean;
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

// ── API shapes (custom roles spec §6) ────────────────────────────────────────

/**
 * One entry of `PUT /team/roles/:id/grants` or `PUT /team/members/:userId/grants`.
 * The list replaces what is there; an entry already past its `expiresAt` is
 * dropped, so a grant that lapsed while the editor was open stays lapsed.
 */
export interface GrantInput {
  resourceType: ResourceType;
  selector: GrantSelector;
  resourceId?: string | null;
  tag?: string | null;
  /** Clusters only; null/absent = every namespace. */
  namespaces?: string[] | null;
  level: AccessLevel;
  /** When it ends; null/absent = permanent. Wins over `expiresInMinutes`. */
  expiresAt?: string | null;
  /** Minutes from now, for a new time-bound entry. */
  expiresInMinutes?: number | null;
  reason?: string | null;
}

/** A role member as the role editor shows them. */
export interface RoleMemberDetail extends RoleMember {
  email: string;
  displayName: string;
  /** Their base role in the org. */
  role: string;
}

/** `GET /team/roles/:id`. */
export interface CustomRoleDetail extends CustomRole {
  grants: RoleGrant[];
  members: RoleMemberDetail[];
}

/** Body of `POST /team/roles` and `PATCH /team/roles/:id`. */
export interface SaveCustomRole {
  name?: string;
  description?: string | null;
  color?: string | null;
  /** Create only: the role's resources. */
  grants?: GrantInput[];
  /** The role's module levels (unified roles spec §3); a module left out is `none`. */
  modulePermissions?: ModulePermissions;
}

/** Any resource access can be granted on, as pickers and lists name it. */
export interface ResourceSummary {
  type: ResourceType;
  id: string;
  name: string;
  /** Host, URL or similar. */
  detail?: string | null;
  /** Servers only. */
  tags?: string[];
}

/** `GET /team/access/resources` (admins): every resource of every type, for pickers. */
export type AccessResources = Record<ResourceType, ResourceSummary[]>;

/** One resource in a member's effective access. */
export interface EffectiveAccessEntry extends EffectiveAccess {
  name: string;
}

/** A custom role a member holds. */
export interface HeldRole {
  roleId: string;
  name: string;
  color: string | null;
  expiresAt: string | null;
  /** The built-in role it is, if any. */
  system?: BuiltInRole | null;
}

/** `GET /team/access/explain`: the access checker's answer. */
export interface AccessExplanation extends EffectiveAccess {
  user: { id: string; email: string; displayName: string; role: string; scope: MemberScope };
  resource: { name: string };
}

/** One member in `GET /team/access/resource` (who has access). */
export interface ResourceAccessHolder {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  scope: MemberScope;
  level: AccessLevel;
  via: AccessReason[];
  namespaces?: string[] | null;
}

export interface ResourceAccessList {
  resourceType: ResourceType;
  resourceId: string;
  name: string;
  holders: ResourceAccessHolder[];
}

/**
 * `GET /team/access/mine?type=`: the caller's level on each resource of a
 * type they can see, so the UI can hide what the level does not allow (the
 * server enforces regardless). `namespaces` lists, for clusters narrowed to
 * some namespaces, which ones.
 */
export interface MyAccessLevels {
  resourceType: ResourceType;
  /** Owners and admins: `manage` on everything. */
  orgAdmin: boolean;
  levels: Record<string, AccessLevel>;
  namespaces?: Record<string, string[]>;
  /**
   * Actions the member's base role (scope `all`) still allows on every
   * resource of the type they see, above their level — a scope-`all`
   * operator edits saved commands and edits or deletes cron jobs, as before
   * custom roles.
   */
  baseActions?: string[];
}

/** A custom role a member may ask for (names only). */
export interface RequestableRole {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  /** Present when the member holds it now; null expiry means permanent. */
  held: { expiresAt: string | null } | null;
}

/** A resource a member may ask for, or ask more of. `level` is what they have now. */
export interface RequestableResource {
  type: ResourceType;
  id: string;
  name: string;
  level: AccessLevel | null;
}

/** `GET /access-requests/requestable`: roles and resources the caller may ask for. */
export interface RequestableAccess {
  /** False for owners and admins, who have everything already. */
  canRequest: boolean;
  settings: { restrictedSeeServerNames: boolean; maxRequestMinutes: number };
  roles: RequestableRole[];
  resources: RequestableResource[];
}

// ── Unified roles and module permissions (unified roles spec §2–§3) ──────────

/**
 * What a role gives on a module: `none` (off), `view`, `operate` or `manage`,
 * each implying the ones before it. Not every module uses every level (see
 * `MODULES`); a level above a module's highest counts as its highest.
 */
export type ModuleLevel = 'none' | 'view' | 'operate' | 'manage';

export const MODULE_LEVELS: readonly ModuleLevel[] = ['none', 'view', 'operate', 'manage'];

/**
 * The modules of the app. Resource modules hold items reached through
 * resource grants; their level adds features not tied to an item (`manage`:
 * create items, module-wide settings). Org modules are features of the org.
 * Team & Access is three modules (members, roles, sign-in & SSO) so an org
 * can delegate inviting people without editing roles.
 */
export type ModuleKey =
  | 'servers'
  | 'containers'
  | 'kubernetes'
  | 'ftp'
  | 'storage'
  | 'cloud'
  | 'saved_commands'
  | 'cron_jobs'
  | 'dashboard'
  | 'monitoring'
  | 'diagnostics'
  | 'ai'
  | 'recordings'
  | 'audit'
  | 'ssh_keys'
  | 'agents'
  | 'team_members'
  | 'team_roles'
  | 'team_sign_in'
  | 'settings';

export type ModuleKind = 'resource' | 'org';

export interface ModuleDefinition {
  key: ModuleKey;
  label: string;
  kind: ModuleKind;
  /** Modules shown together in the role editor (Team & Access). */
  group?: 'team';
  /** The levels the module uses, lowest first (`none` is always possible). */
  levels: readonly Exclude<ModuleLevel, 'none'>[];
  /** Resource modules: the resource type whose items they hold. */
  resourceType?: ResourceType;
  /** What each level allows, in plain words, for the role editor. */
  hints: Partial<Record<Exclude<ModuleLevel, 'none'>, string>>;
}

const RESOURCE_LEVELS = ['view', 'operate', 'manage'] as const;

/** The module catalogue (spec §3), in the order the editor and navigation show it. */
export const MODULES: readonly ModuleDefinition[] = [
  { key: 'dashboard', label: 'Dashboard', kind: 'org', levels: ['view'], hints: { view: 'Shown, limited to what the member can see' } },
  {
    key: 'servers',
    label: 'Servers',
    kind: 'resource',
    resourceType: 'server',
    levels: RESOURCE_LEVELS,
    hints: { view: 'Servers granted to them', operate: 'Servers granted to them', manage: 'Add servers' },
  },
  {
    key: 'containers',
    label: 'Containers',
    kind: 'resource',
    resourceType: 'server',
    levels: RESOURCE_LEVELS,
    hints: { view: 'Containers on their servers', operate: 'Containers on their servers', manage: 'Docker settings' },
  },
  {
    key: 'kubernetes',
    label: 'Kubernetes',
    kind: 'resource',
    resourceType: 'cluster',
    levels: RESOURCE_LEVELS,
    hints: { view: 'Clusters granted to them', operate: 'Clusters granted to them', manage: 'Add clusters, Kubernetes settings' },
  },
  {
    key: 'ftp',
    label: 'FTP',
    kind: 'resource',
    resourceType: 'ftp_connection',
    levels: RESOURCE_LEVELS,
    hints: { view: 'Connections granted to them', operate: 'Connections granted to them', manage: 'Add connections' },
  },
  {
    key: 'storage',
    label: 'Object Storage',
    kind: 'resource',
    resourceType: 'storage_connection',
    levels: RESOURCE_LEVELS,
    hints: { view: 'Connections granted to them', operate: 'Connections granted to them', manage: 'Add connections' },
  },
  {
    key: 'cloud',
    label: 'Cloud Accounts',
    kind: 'resource',
    resourceType: 'cloud_account',
    levels: RESOURCE_LEVELS,
    hints: { view: 'Accounts granted to them', operate: 'Accounts granted to them', manage: 'Add accounts' },
  },
  {
    key: 'saved_commands',
    label: 'Saved Commands',
    kind: 'resource',
    resourceType: 'saved_command',
    levels: RESOURCE_LEVELS,
    hints: { view: 'Commands granted to them', operate: 'Commands granted to them', manage: 'Create commands, edit any they see' },
  },
  {
    key: 'cron_jobs',
    label: 'Cron Jobs',
    kind: 'resource',
    resourceType: 'cron_job',
    levels: RESOURCE_LEVELS,
    hints: { view: 'Jobs granted to them', operate: 'Jobs granted to them', manage: 'Create jobs, edit or delete any they see' },
  },
  {
    key: 'monitoring',
    label: 'Monitoring & Alerts',
    kind: 'org',
    levels: ['view', 'operate', 'manage'],
    hints: { view: 'Alerts of their servers and clusters', operate: 'Acknowledge alerts', manage: 'Alert rules, notification channels' },
  },
  {
    key: 'diagnostics',
    label: 'DNS Lookup & Diagnostics',
    kind: 'org',
    levels: ['view', 'operate'],
    hints: { view: 'Run lookups', operate: 'Diagnose with a login' },
  },
  {
    key: 'ai',
    label: 'AI Assistant',
    kind: 'org',
    levels: ['view', 'manage'],
    hints: { view: 'Chat (tools still per resource)', manage: 'AI provider settings' },
  },
  {
    key: 'recordings',
    label: 'Recordings',
    kind: 'org',
    levels: ['view', 'operate', 'manage'],
    hints: { view: 'Their own recordings', operate: 'All recordings of what they see', manage: 'Delete, retention, recording settings' },
  },
  {
    key: 'audit',
    label: 'Audit Log',
    kind: 'org',
    levels: ['view', 'operate', 'manage'],
    hints: { view: 'Read the log', operate: 'Export', manage: 'Retention, forwarding' },
  },
  {
    key: 'ssh_keys',
    label: 'SSH Keys',
    kind: 'org',
    levels: ['view', 'operate', 'manage'],
    hints: { view: 'List keys', operate: 'Use keys in forms', manage: 'Create, import, rotate and delete keys' },
  },
  {
    key: 'agents',
    label: 'Agents',
    kind: 'org',
    levels: ['view', 'manage'],
    hints: { view: 'List agents and their status', manage: 'Create, revoke and assign agents' },
  },
  {
    key: 'team_members',
    label: 'Members',
    kind: 'org',
    group: 'team',
    levels: ['view', 'operate'],
    hints: { view: 'See members', operate: 'Invite, suspend, sign out and reset passwords (members whose roles they hold)' },
  },
  {
    key: 'team_roles',
    label: 'Roles & access',
    kind: 'org',
    group: 'team',
    levels: ['view', 'manage'],
    hints: { view: 'See roles and effective access', manage: 'Edit and assign roles, grants, approve access requests' },
  },
  {
    key: 'team_sign_in',
    label: 'Sign-in & SSO',
    kind: 'org',
    group: 'team',
    levels: ['view', 'manage'],
    hints: { view: 'See sign-in policy', manage: 'Single sign-on, passkey policy, sign-in security' },
  },
  {
    key: 'settings',
    label: 'Organization settings',
    kind: 'org',
    levels: ['manage'],
    hints: { manage: 'Org name, default role, Docker and Kubernetes settings' },
  },
];

export const MODULE_KEYS: readonly ModuleKey[] = MODULES.map((m) => m.key);

/** A role's module levels; a module left out is `none`. */
export type ModulePermissions = Partial<Record<ModuleKey, ModuleLevel>>;

/**
 * The roles every org has (spec §2.2). Owner and No access are locked; Admin,
 * Operator and Viewer are editable, with "Reset to default" going back to
 * `BUILT_IN_ROLE_DEFAULTS`. None can be deleted.
 */
export type BuiltInRole = 'owner' | 'admin' | 'operator' | 'viewer' | 'none';

export const BUILT_IN_ROLES: readonly BuiltInRole[] = ['owner', 'admin', 'operator', 'viewer', 'none'];

export interface BuiltInRoleDefaults {
  name: string;
  description: string;
  /** Owner and No access cannot be changed. */
  editable: boolean;
  modules: ModulePermissions;
  /** The level of the role's "All …" grant on every resource type; null = none. Owner: everything, always. */
  grantLevel: AccessLevel | null;
}

const VIEWER_MODULES: ModulePermissions = {
  dashboard: 'view',
  servers: 'view',
  containers: 'view',
  kubernetes: 'view',
  ftp: 'view',
  storage: 'view',
  cloud: 'view',
  saved_commands: 'view',
  cron_jobs: 'view',
  // Acknowledging still needs operate on the alert's server, as before
  monitoring: 'operate',
  diagnostics: 'view',
  recordings: 'view',
  ssh_keys: 'view',
  team_members: 'view',
};

const OPERATOR_MODULES: ModulePermissions = {
  ...VIEWER_MODULES,
  servers: 'operate',
  containers: 'operate',
  kubernetes: 'operate',
  ftp: 'operate',
  storage: 'operate',
  cloud: 'operate',
  // Operators have always created saved commands and cron jobs, and edited those they see
  saved_commands: 'manage',
  cron_jobs: 'manage',
  diagnostics: 'operate',
  ai: 'view',
};

/** Every module at its highest level. */
const ALL_MODULES: ModulePermissions = Object.fromEntries(
  MODULES.map((m) => [m.key, m.levels[m.levels.length - 1]]),
) as ModulePermissions;

/**
 * What the built-in roles hold by default. These reproduce exactly what the
 * base roles allowed before unified roles (spec §2.6), so migrating changes
 * nobody's access; that is why Viewer keeps the org features every member
 * had (dashboard, alerts, DNS lookups, own recordings, key and member lists).
 */
export const BUILT_IN_ROLE_DEFAULTS: Record<BuiltInRole, BuiltInRoleDefaults> = {
  owner: {
    name: 'Owner',
    description: 'Everything, including transferring ownership, backups and deleting the organization',
    editable: false,
    modules: ALL_MODULES,
    grantLevel: 'manage',
  },
  admin: {
    name: 'Admin',
    description: 'Every module and every resource, managed',
    editable: true,
    modules: ALL_MODULES,
    grantLevel: 'manage',
  },
  operator: {
    name: 'Operator',
    description: 'Operates every resource; AI Assistant and diagnostics',
    editable: true,
    modules: OPERATOR_MODULES,
    grantLevel: 'operate',
  },
  viewer: {
    name: 'Viewer',
    description: 'Sees every resource',
    editable: true,
    modules: VIEWER_MODULES,
    grantLevel: 'view',
  },
  none: {
    name: 'No access',
    description: 'Nothing beyond their own account',
    editable: false,
    modules: {},
    grantLevel: null,
  },
};

/**
 * The roles migration 0025 generated for role-scoped members ("only resources
 * from roles"): the base role's modules without its "All …" grants. Operators
 * there could not create saved commands or cron jobs, so those stay `operate`.
 * Ordinary editable roles once created.
 */
export const MODULES_ONLY_DEFAULTS: Record<'operator' | 'viewer', { name: string; description: string; modules: ModulePermissions }> = {
  operator: {
    name: 'Operator (modules only)',
    description: 'Operator features; resources only from other roles and grants',
    modules: { ...OPERATOR_MODULES, saved_commands: 'operate', cron_jobs: 'operate' },
  },
  viewer: {
    name: 'Viewer (modules only)',
    description: 'Viewer features; resources only from other roles and grants',
    modules: VIEWER_MODULES,
  },
};

/** One visible module and the member's level there. */
export interface ModuleAccess {
  module: ModuleKey;
  level: Exclude<ModuleLevel, 'none'>;
}

/** `GET /api/me/modules`: the modules to show the caller (spec §3.1 visibility rule), for navigation. */
export interface MeModules {
  modules: ModuleAccess[];
}

/** A role the caller holds, for `GET /api/me/access`. */
export interface MeRole {
  id: string;
  name: string;
  /** Set for built-in roles. */
  system: BuiltInRole | null;
  color: string | null;
  expiresAt: string | null;
}

/** `GET /api/me/access`: what the caller holds and may do, for the web. */
export interface MeAccess {
  /** Holds the Owner role (owner-only actions, spec §4.3). */
  owner: boolean;
  /** No module is visible: the "ask an admin" home. */
  noAccess: boolean;
  /** A read-only API token: every level capped at `view`. */
  readOnly: boolean;
  roles: MeRole[];
  /** The caller's level on every module (union of their roles), whether shown or not. */
  modules: Record<ModuleKey, ModuleLevel>;
  /** The modules to show (spec §3.1). */
  visible: ModuleKey[];
  /** Per resource type: whether they reach every item, and how many items they reach. */
  resources: Record<ResourceType, { all: boolean; count: number }>;
}

/**
 * Permissions an actor wants to give (assign a role, edit one, grant, approve
 * a request): the delegation guard (spec §4.2) allows it only when the actor
 * holds each of them at the same or a higher level.
 */
export interface PermissionSet {
  modules?: ModulePermissions;
  grants?: Pick<GrantInput, 'resourceType' | 'selector' | 'resourceId' | 'tag' | 'namespaces' | 'level'>[];
}

/** Where a member's level on a module comes from: one role they hold. */
export interface ModuleAccessReason {
  roleId: string;
  name: string;
  system: BuiltInRole | null;
  level: Exclude<ModuleLevel, 'none'>;
  expiresAt: string | null;
}

/** A member's level on one module, whether it is shown to them, and which roles give it. */
export interface MemberModuleAccess {
  module: ModuleKey;
  level: ModuleLevel;
  /** Shown in their navigation (spec §3.1): on, and for a resource module something in it. */
  visible: boolean;
  /** Every role giving the module, highest level first. */
  via: ModuleAccessReason[];
}

/** `GET`/`PUT /team/default-role`: the role new members get when none is picked (invites, SSO). */
export interface DefaultRole {
  roleId: string;
  name: string;
}
