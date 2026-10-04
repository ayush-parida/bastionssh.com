import {
  ACCESS_LEVELS,
  BUILT_IN_ROLE_DEFAULTS,
  MODULE_KEYS,
  MODULE_LEVELS,
  MODULES,
  RESOURCE_TYPES,
  type AccessLevel,
  type ModuleDefinition,
  type ModuleKey,
  type ModuleLevel,
  type ModulePermissions,
  type ResourceType,
  type Role,
} from '@smt/shared';

/**
 * Resource levels (custom roles spec §5): their order, what each base role
 * means on a resource, and which level every action needs. One table, so a
 * route asks for an action and never hard-codes a level. Module levels
 * (unified roles spec §3) are at the end.
 */

export function levelRank(level: AccessLevel): number {
  return ACCESS_LEVELS.indexOf(level);
}

export function isAccessLevel(value: unknown): value is AccessLevel {
  return typeof value === 'string' && (ACCESS_LEVELS as readonly string[]).includes(value);
}

export function isResourceType(value: unknown): value is ResourceType {
  return typeof value === 'string' && (RESOURCE_TYPES as readonly string[]).includes(value);
}

export function maxLevel(a: AccessLevel, b: AccessLevel): AccessLevel {
  return levelRank(a) >= levelRank(b) ? a : b;
}

export function meetsLevel(level: AccessLevel | null | undefined, required: AccessLevel): boolean {
  return !!level && levelRank(level) >= levelRank(required);
}

/** What a base role means on every resource when it applies (scope `all`, or admins). Unknown roles get the least. */
export function baseLevel(role: string): AccessLevel {
  if (role === 'owner' || role === 'admin') return 'manage';
  if (role === 'operator') return 'operate';
  return 'view';
}

/**
 * The base role whose permission matrix matches a level on one resource — for
 * the Docker and Kubernetes matrices in @smt/shared, which are written per
 * role: `operate` behaves like an operator there (org toggles included), and
 * `manage` like an admin.
 */
export function roleForLevel(level: AccessLevel): Role {
  return level === 'manage' ? 'admin' : level === 'operate' ? 'operator' : 'viewer';
}

/**
 * `roleForLevel` for a module level: the matrix that applies where no single
 * resource is asked about (the container fleet, adding a cluster). Off reads
 * as the least, a viewer; the module's own gate answers 404 first.
 */
export function roleForModuleLevel(level: ModuleLevel): Role {
  return roleForLevel(level === 'none' ? 'view' : level);
}

/**
 * The level each action needs, per resource type (spec §5). Dependent objects
 * follow their parent: Docker, recordings, diagnostics and host keys are
 * server actions; Kubernetes views and actions are cluster actions.
 */
export const ACTION_LEVELS = {
  server: {
    view: 'view',
    health: 'view',
    metrics: 'view',
    host_key_status: 'view',
    docker_view: 'view',
    recordings: 'view',
    terminal: 'operate',
    sftp: 'operate',
    run_command: 'operate',
    docker_operate: 'operate',
    diagnose: 'operate',
    health_check: 'operate',
    edit: 'manage',
    tags: 'manage',
    host_keys: 'manage',
    rotate_keys: 'manage',
    docker_manage: 'manage',
    delete: 'manage',
  },
  cluster: {
    view: 'view',
    logs: 'operate',
    yaml: 'operate',
    scale: 'operate',
    delete_pod: 'operate',
    exec: 'operate',
    explain: 'operate',
    diagnose: 'operate',
    rollback: 'manage',
    cordon: 'manage',
    configure: 'manage',
    delete: 'manage',
  },
  // Reading is `view` (browse and download), writing and testing `operate`
  ftp_connection: {
    view: 'view',
    browse: 'view',
    download: 'view',
    upload: 'operate',
    rename: 'operate',
    delete_files: 'operate',
    test: 'operate',
    edit: 'manage',
    host_key: 'manage',
    delete: 'manage',
  },
  // As for FTP: reading is `view` (list and download), writing and testing `operate`
  storage_connection: {
    view: 'view',
    list: 'view',
    download: 'view',
    upload: 'operate',
    delete_objects: 'operate',
    // Connectivity checks with the stored credentials, as for FTP and servers
    diagnose: 'operate',
    test: 'operate',
    buckets: 'manage',
    edit: 'manage',
    delete: 'manage',
  },
  cloud_account: {
    view: 'view',
    instances: 'view',
    sync: 'operate',
    // Re-checks the stored credentials: kept with editing them, as before (admin)
    test: 'manage',
    edit: 'manage',
    delete: 'manage',
  },
  saved_command: {
    view: 'view',
    run: 'operate',
    edit: 'manage',
    delete: 'manage',
  },
  cron_job: {
    view: 'view',
    history: 'view',
    run: 'operate',
    toggle: 'operate',
    edit: 'manage',
    delete: 'manage',
  },
} as const satisfies Record<ResourceType, Record<string, AccessLevel>>;

/** An action on a resource type, e.g. `ResourceAction<'server'>` = 'view' | 'terminal' | … */
export type ResourceAction<T extends ResourceType = ResourceType> = keyof (typeof ACTION_LEVELS)[T] & string;

/** The level `action` needs on `type`; unknown actions need `manage`, never less. */
export function requiredLevel<T extends ResourceType>(type: T, action: ResourceAction<T>): AccessLevel {
  const levels = ACTION_LEVELS[type] as Record<string, AccessLevel>;
  return levels[action] ?? 'manage';
}

/** What the API says a resource of each type is called, for "… not found". */
export const RESOURCE_LABELS: Record<ResourceType, string> = {
  server: 'Server',
  cluster: 'Cluster',
  ftp_connection: 'FTP connection',
  storage_connection: 'Storage connection',
  cloud_account: 'Cloud account',
  saved_command: 'Saved command',
  cron_job: 'Cron job',
};

// ── Module levels (unified roles spec §3) ─────────────────────────────────────

export function moduleRank(level: ModuleLevel): number {
  return MODULE_LEVELS.indexOf(level);
}

export function meetsModuleLevel(level: ModuleLevel | null | undefined, required: ModuleLevel): boolean {
  return !!level && moduleRank(level) >= moduleRank(required);
}

export function maxModuleLevel(a: ModuleLevel, b: ModuleLevel): ModuleLevel {
  return moduleRank(a) >= moduleRank(b) ? a : b;
}

export function isModuleKey(value: unknown): value is ModuleKey {
  return typeof value === 'string' && (MODULE_KEYS as readonly string[]).includes(value);
}

const MODULE_BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

export function moduleDefinition(key: ModuleKey): ModuleDefinition {
  return MODULE_BY_KEY.get(key)!;
}

/** A module's highest level: what "everything" is there. */
export function topModuleLevel(key: ModuleKey): ModuleLevel {
  const { levels } = moduleDefinition(key);
  return levels[levels.length - 1]!;
}

/** `level` as the module can hold it: anything above its highest counts as its highest. */
export function clampModuleLevel(key: ModuleKey, level: ModuleLevel): ModuleLevel {
  const top = topModuleLevel(key);
  return moduleRank(level) > moduleRank(top) ? top : level;
}

/** Every module at `none`. */
export function noModules(): Record<ModuleKey, ModuleLevel> {
  return Object.fromEntries(MODULE_KEYS.map((key) => [key, 'none'])) as Record<ModuleKey, ModuleLevel>;
}

/** Every module at its highest level (the Owner role). */
export function allModules(): Record<ModuleKey, ModuleLevel> {
  return Object.fromEntries(MODULE_KEYS.map((key) => [key, topModuleLevel(key)])) as Record<ModuleKey, ModuleLevel>;
}

/**
 * A role's stored module permissions. Unknown modules and levels are dropped
 * and anything unreadable counts as nothing — never as more.
 */
export function parseModulePermissions(raw: string | null | undefined): ModulePermissions {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const permissions: ModulePermissions = {};
  for (const [key, level] of Object.entries(value as Record<string, unknown>)) {
    if (!isModuleKey(key) || typeof level !== 'string' || !(MODULE_LEVELS as readonly string[]).includes(level)) continue;
    permissions[key] = clampModuleLevel(key, level as ModuleLevel);
  }
  return permissions;
}

/**
 * The resource module whose level decides whether grants of a type count:
 * a role with that module at `none` keeps its grants parked (spec §10.4).
 * Containers are a view over servers and follow the Servers module.
 */
export const TYPE_MODULES: Record<ResourceType, ModuleKey> = {
  server: 'servers',
  cluster: 'kubernetes',
  ftp_connection: 'ftp',
  storage_connection: 'storage',
  cloud_account: 'cloud',
  saved_command: 'saved_commands',
  cron_job: 'cron_jobs',
};

/**
 * The base role a set of module levels amounts to, for the compatible `role`
 * fields old API callers read (`compatRole`, member lists, invites) — no
 * route gates on it: the highest of Admin, Operator and Viewer whose default org-module
 * levels the member holds every one of (resource modules do not count —
 * items come from grants). Owners are decided by holding the Owner role, not
 * here. With every built-in at its defaults this is exactly the member's base
 * role before unified roles; holding less than Viewer's still counts as
 * viewer, the least these gates know.
 */
export function legacyRoleFor(modules: Record<ModuleKey, ModuleLevel>): Exclude<Role, 'owner'> {
  const holds = (role: 'admin' | 'operator') =>
    Object.entries(BUILT_IN_ROLE_DEFAULTS[role].modules).every(
      ([key, level]) => moduleDefinition(key as ModuleKey).kind === 'resource' || meetsModuleLevel(modules[key as ModuleKey], level),
    );
  if (holds('admin')) return 'admin';
  if (holds('operator')) return 'operator';
  return 'viewer';
}
