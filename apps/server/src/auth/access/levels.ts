import { ACCESS_LEVELS, RESOURCE_TYPES, type AccessLevel, type ResourceType, type Role } from '@smt/shared';

/**
 * Resource levels (custom roles spec §5): their order, what each base role
 * means on a resource, and which level every action needs. One table, so a
 * route asks for an action and never hard-codes a level.
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
    rollback: 'manage',
    cordon: 'manage',
    configure: 'manage',
    delete: 'manage',
  },
  ftp_connection: {
    view: 'view',
    browse: 'operate',
    upload: 'operate',
    download: 'operate',
    rename: 'operate',
    delete_files: 'operate',
    test: 'operate',
    edit: 'manage',
    host_key: 'manage',
    delete: 'manage',
  },
  storage_connection: {
    view: 'view',
    list: 'view',
    upload: 'operate',
    download: 'operate',
    delete_objects: 'operate',
    edit: 'manage',
    delete: 'manage',
  },
  cloud_account: {
    view: 'view',
    instances: 'view',
    sync: 'operate',
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
