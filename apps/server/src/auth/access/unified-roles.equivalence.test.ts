import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import {
  ACCESS_LEVELS,
  BUILT_IN_ROLE_DEFAULTS,
  RESOURCE_TYPES,
  type AccessLevel,
  type AccessReason,
  type ResourceType,
  type Role,
} from '@smt/shared';
import { getDb, getRawDb } from '../../db/index.js';
import { apiTokens, memberships, resourceGrants, roleMembers, roles } from '../../db/schema.js';
import { generateApiToken } from '../token.js';
import { rank, requireAuth, requireRole, ROLES } from '../middleware.js';
import { baseRoleAllows, mayCreate } from '../command-access.js';
import { ACTION_LEVELS, baseLevel, isAccessLevel, isResourceType, meetsLevel, requiredLevel, type ResourceAction } from './levels.js';
import { authorize, levelForAccess } from './authorize.js';
import { accessibleIds, accessibleIdsFor, reachesAny, reachesAnyFor } from './filter.js';
import { emptyTypes, resolveAccess, type AccessSubject, type Contribution, type ResolvedAccess } from './resolve.js';
import { isOrgOwner, isOwner } from './modules.js';

/**
 * Migration 0025 (unified roles spec §6.5): every member's effective access is
 * identical before and after. Fixture orgs hold every combination of base role
 * (owner, admin, operator, viewer and an unknown one) × scope × custom roles
 * (by id, tag, "all", cluster namespaces; permanent, expiring and expired
 * memberships; expired grants; a role named like a built-in) × personal grants
 * (by id, tag, namespaces, expiring and expired, `legacy-all`, mirrored
 * per-member rows, malformed), active and suspended, read-write and read-only.
 *
 * "Before" is the resolver as it was at migration 0024, frozen below
 * (`legacyLoad`) and read against the database before 0025 runs; "after" is
 * the live engine once it has. For every member they must agree on every
 * resource action (and level and namespaces) of every resource, on every
 * accessible set, on "reaches any", and on everything the base role decided:
 * every `requireRole` gate through the real `requireAuth`, owner checks, and
 * the operator rights on saved commands and cron jobs.
 */

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
const journal = JSON.parse(fs.readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
const UNIFIED_TAG = '0025_unified_roles';

function apply(tags: string[]) {
  const raw = getRawDb();
  for (const tag of tags) {
    for (const statement of fs.readFileSync(path.join(dir, `${tag}.sql`), 'utf8').split('--> statement-breakpoint')) {
      if (statement.trim()) raw.exec(statement);
    }
  }
}

// ── The resolver at migration 0024, verbatim but for the memo ─────────────────

const ROLE_NAMES: readonly Role[] = ['viewer', 'operator', 'admin', 'owner'];

function activeAt(column: Parameters<typeof isNull>[0], now: string) {
  return or(isNull(column), gt(column, now))!;
}

function parseNamespaces(raw: string | null): string[] | null | undefined {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every((ns) => typeof ns === 'string')) return value as string[];
  } catch {
    /* fall through */
  }
  return undefined;
}

function push<K>(map: Map<K, Contribution[]>, key: K, contribution: Contribution) {
  const list = map.get(key);
  if (list) list.push(contribution);
  else map.set(key, [contribution]);
}

interface Legacy extends ResolvedAccess {
  scope: 'all' | 'roles';
}

function legacyLoad(orgId: string, userId: string, readOnly: boolean, now = new Date().toISOString()): Legacy {
  const db = getDb();
  const access: Legacy = {
    orgId,
    userId,
    active: false,
    owner: false,
    role: 'viewer',
    scope: 'roles',
    orgAdmin: false,
    readOnly,
    roles: [],
    modules: {} as ResolvedAccess['modules'],
    types: emptyTypes(),
    memo: new Map(),
  };

  const membership = db
    .select({ role: memberships.role, status: memberships.status, scope: memberships.scope })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .get();
  if (!membership || membership.status !== 'active') return access;

  const role = (ROLE_NAMES as readonly string[]).includes(membership.role) ? (membership.role as Role) : 'viewer';
  access.active = true;
  access.role = role;
  access.orgAdmin = role === 'owner' || role === 'admin';
  access.scope = membership.scope === 'roles' && !access.orgAdmin ? 'roles' : 'all';

  if (access.scope === 'all') {
    const level = baseLevel(role);
    for (const type of RESOURCE_TYPES) {
      access.types[type].every.push({ level, reason: { kind: 'base', name: role, level }, namespaces: null });
    }
  }
  if (access.orgAdmin) return access;

  const held = db
    .select({ roleId: roleMembers.roleId, name: roles.name, expiresAt: roleMembers.expiresAt })
    .from(roleMembers)
    .innerJoin(roles, eq(roles.id, roleMembers.roleId))
    .where(and(eq(roleMembers.orgId, orgId), eq(roleMembers.userId, userId), eq(roles.orgId, orgId), activeAt(roleMembers.expiresAt, now)))
    .all();
  const heldById = new Map(held.map((r) => [r.roleId, r]));

  const grants = db
    .select({
      id: resourceGrants.id,
      principalType: resourceGrants.principalType,
      principalId: resourceGrants.principalId,
      resourceType: resourceGrants.resourceType,
      selector: resourceGrants.selector,
      resourceId: resourceGrants.resourceId,
      tag: resourceGrants.tag,
      namespaces: resourceGrants.namespaces,
      level: resourceGrants.level,
      expiresAt: resourceGrants.expiresAt,
    })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.orgId, orgId),
        or(
          and(eq(resourceGrants.principalType, 'user'), eq(resourceGrants.principalId, userId)),
          held.length ? and(eq(resourceGrants.principalType, 'role'), inArray(resourceGrants.principalId, [...heldById.keys()])) : undefined,
        ),
        activeAt(resourceGrants.expiresAt, now),
      ),
    )
    .all();

  for (const grant of grants) {
    if (!isResourceType(grant.resourceType) || !isAccessLevel(grant.level)) continue;
    const type = grant.resourceType;
    const namespaces = type === 'cluster' ? parseNamespaces(grant.namespaces) : null;
    if (namespaces === undefined) continue;

    let reason: AccessReason;
    if (grant.principalType === 'role') {
      const viaRole = heldById.get(grant.principalId);
      if (!viaRole) continue;
      const ends = [viaRole.expiresAt, grant.expiresAt].filter((e): e is string => e !== null).sort()[0] ?? null;
      reason = { kind: 'role', name: viaRole.name, roleId: viaRole.roleId, level: grant.level, expiresAt: ends };
    } else if (grant.principalType === 'user') {
      reason = { kind: 'grant', name: 'personal', grantId: grant.id, level: grant.level, expiresAt: grant.expiresAt };
    } else {
      continue;
    }
    reason.selector = grant.selector as AccessReason['selector'];
    if (type === 'cluster') reason.namespaces = namespaces;

    const contribution: Contribution = { level: grant.level, reason, namespaces };
    if (grant.selector === 'all') access.types[type].every.push(contribution);
    else if (grant.selector === 'id' && grant.resourceId) push(access.types[type].byId, grant.resourceId, contribution);
    else if (grant.selector === 'tag' && type === 'server' && grant.tag) {
      reason.tag = grant.tag;
      push(access.types[type].byTag, grant.tag, contribution);
    }
  }
  return access;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PAST = '2000-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';
const ORG = 'o1';
const OTHER = 'o2';

/** Resources per type (o1), plus one of each in o2 that nobody in o1 may reach. */
const RESOURCES: Record<ResourceType, string[]> = {
  server: ['s-web', 's-webdb', 's-bare', 'x-s'],
  cluster: ['k1', 'k2', 'x-k'],
  ftp_connection: ['f1', 'f2', 'x-f'],
  storage_connection: ['st1', 'x-st'],
  cloud_account: ['c1', 'x-c'],
  saved_command: ['sc-bound', 'sc-free', 'x-sc'],
  cron_job: ['cj1', 'x-cj'],
};
const NAMESPACES = [undefined, 'shop', 'a', 'other'];

/** Custom roles of o1 and their grants. `Viewer` collides with a built-in name and is renamed. */
const CUSTOM_ROLES: { id: string; name: string; grants: [ResourceType, 'id' | 'tag' | 'all', string | null, AccessLevel, string[] | null, string | null][] }[] = [
  {
    id: 'r-id',
    name: 'By id',
    grants: [
      ['server', 'id', 's-web', 'operate', null, null],
      ['cluster', 'id', 'k1', 'manage', ['shop'], null],
      ['ftp_connection', 'id', 'f1', 'operate', null, FUTURE],
      ['saved_command', 'id', 'sc-bound', 'manage', null, null],
    ],
  },
  {
    id: 'r-tag',
    name: 'Viewer',
    grants: [
      ['server', 'tag', 'web', 'manage', null, null],
      ['saved_command', 'all', null, 'operate', null, null],
      ['cluster', 'id', 'k2', 'view', ['a', 'b'], null],
    ],
  },
  {
    id: 'r-all',
    name: 'Everything a bit',
    grants: [
      ['cron_job', 'all', null, 'manage', null, null],
      ['storage_connection', 'all', null, 'view', null, null],
      ['cloud_account', 'id', 'c1', 'operate', null, null],
      ['cluster', 'all', null, 'operate', null, null],
    ],
  },
  {
    id: 'r-expired-grants',
    name: 'Lapsed',
    grants: [
      ['server', 'id', 's-bare', 'manage', null, PAST],
      ['ftp_connection', 'all', null, 'manage', null, PAST],
      ['cluster', 'id', 'k2', 'view', null, null],
    ],
  },
];

/** Sets of role memberships a member may hold: [roleId, expiresAt]. */
const ROLE_SETS: [string, string | null][][] = [
  [],
  [['r-id', null]],
  [['r-tag', FUTURE], ['r-all', PAST]],
  [['r-id', null], ['r-tag', null], ['r-all', FUTURE], ['r-expired-grants', null]],
];

/** Sets of personal grants: [type, selector, resourceId|tag, level, namespaces, expiresAt, id prefix]. */
type Personal = [ResourceType, 'id' | 'tag' | 'all', string | null, AccessLevel | 'bogus', string[] | null | 'bad', string | null, string];
const PERSONAL_SETS: Personal[][] = [
  [],
  [
    ['server', 'id', 's-webdb', 'manage', null, FUTURE, ''],
    ['cluster', 'id', 'k2', 'operate', ['a', 'b'], null, ''],
    ['server', 'id', 's-bare', 'operate', null, PAST, ''],
  ],
  // As migration 0023 left restricted members: `legacy-all` grants on the other types
  [
    ['ftp_connection', 'all', null, 'view', null, null, 'legacy-all:'],
    ['storage_connection', 'all', null, 'view', null, null, 'legacy-all:'],
    ['cloud_account', 'all', null, 'view', null, null, 'legacy-all:'],
    ['saved_command', 'all', null, 'view', null, null, 'legacy-all:'],
    ['cron_job', 'all', null, 'view', null, null, 'legacy-all:'],
  ],
  [
    ['server', 'tag', 'db', 'view', null, null, ''],
    ['storage_connection', 'id', 'st1', 'manage', null, null, ''],
    ['cluster', 'id', 'k1', 'manage', 'bad', null, ''],
    ['ftp_connection', 'id', 'f2', 'bogus', null, null, ''],
  ],
];

const BASE_ROLES = ['owner', 'admin', 'operator', 'viewer', 'bogus'];
const SCOPES = ['all', 'roles'];

interface Member {
  userId: string;
  role: string;
  status: string;
  /** Read-write and read-only API tokens. */
  tokens: { rw: string; ro: string };
}

const members: Member[] = [];

function seed() {
  const raw = getRawDb();
  const now = new Date().toISOString();
  raw.exec(`
    INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('${ORG}', 'Org', 'org', 'now', 'now');
    INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('${OTHER}', 'Other', 'other', 'now', 'now');
    INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('creator', 'creator@x.test', 'c', 'now', 'now');
  `);
  const servers: [string, string, string[]][] = [
    ['s-web', ORG, ['web']],
    ['s-webdb', ORG, ['web', 'db']],
    ['s-bare', ORG, []],
    ['x-s', OTHER, ['web']],
  ];
  for (const [id, org, tags] of servers) {
    raw.exec(`INSERT INTO servers (id, org_id, name, host, username, tags, created_by, created_at, updated_at)
      VALUES ('${id}', '${org}', '${id}', 'h', 'root', '${JSON.stringify(tags)}', 'creator', 'now', 'now')`);
  }
  for (const [id, org] of [['k1', ORG], ['k2', ORG], ['x-k', OTHER]]) {
    raw.exec(`INSERT INTO kube_clusters (id, org_id, name, api_url, auth_type, encrypted_credential, credential_hint, created_by, created_at, updated_at)
      VALUES ('${id}', '${org}', '${id}', 'https://10.0.0.5:6443', 'token', 'x', 'h', 'creator', 'now', 'now')`);
  }
  for (const [id, org] of [['f1', ORG], ['f2', ORG], ['x-f', OTHER]]) {
    raw.exec(`INSERT INTO ftp_connections (id, org_id, name, protocol, host, port, username, encrypted_password, created_by, created_at, updated_at)
      VALUES ('${id}', '${org}', '${id}', 'sftp', 'h', 22, 'u', 'x', 'creator', 'now', 'now')`);
  }
  for (const [id, org] of [['st1', ORG], ['x-st', OTHER]]) {
    raw.exec(`INSERT INTO storage_connections (id, org_id, name, access_key_id, encrypted_secret_access_key, created_by, created_at, updated_at)
      VALUES ('${id}', '${org}', '${id}', 'AK', 'x', 'creator', 'now', 'now')`);
  }
  for (const [id, org] of [['c1', ORG], ['x-c', OTHER]]) {
    raw.exec(`INSERT INTO cloud_accounts (id, org_id, name, provider, encrypted_credentials, credential_hint, created_by, created_at, updated_at)
      VALUES ('${id}', '${org}', '${id}', 'aws', 'x', 'h', 'creator', 'now', 'now')`);
  }
  for (const [id, org, server] of [['sc-bound', ORG, "'s-web'"], ['sc-free', ORG, 'NULL'], ['x-sc', OTHER, 'NULL']]) {
    raw.exec(`INSERT INTO saved_commands (id, org_id, name, command, server_id, created_by, created_at, updated_at)
      VALUES ('${id}', '${org}', '${id}', 'uptime', ${server}, 'creator', 'now', 'now')`);
  }
  for (const [id, org, server] of [['cj1', ORG, 's-web'], ['x-cj', OTHER, 'x-s']]) {
    raw.exec(`INSERT INTO cron_jobs (id, org_id, name, schedule, server_id, inline_command, created_by, created_at, updated_at)
      VALUES ('${id}', '${org}', '${id}', '* * * * *', '${server}', 'uptime', 'creator', 'now', 'now')`);
  }

  for (const role of CUSTOM_ROLES) {
    raw.exec(`INSERT INTO roles (id, org_id, name, created_by, created_at, updated_at) VALUES ('${role.id}', '${ORG}', '${role.name}', 'creator', 'now', 'now')`);
    role.grants.forEach(([type, selector, target, level, namespaces, expires], i) => {
      raw.prepare(
        `INSERT INTO resource_grants (id, org_id, principal_type, principal_id, resource_type, selector, resource_id, tag, namespaces, level, expires_at, created_at)
         VALUES (?, ?, 'role', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`${role.id}-${i}`, ORG, role.id, type, selector, selector === 'id' ? target : null, selector === 'tag' ? target : null, namespaces ? JSON.stringify(namespaces) : null, level, expires, now);
    });
  }

  let n = 0;
  const add = (role: string, scope: string, roleSet: [string, string | null][], personal: Personal[], status: string, mirrored: boolean) => {
    const userId = `m${n++}`;
    raw.exec(`INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('${userId}', '${userId}@x.test', '${userId}', 'now', 'now')`);
    raw.exec(`INSERT INTO memberships (user_id, org_id, role, status, server_access, scope, joined_at)
      VALUES ('${userId}', '${ORG}', '${role}', '${status}', '${scope === 'roles' ? 'restricted' : 'all'}', '${scope}', 'now')`);
    for (const [roleId, expires] of roleSet) {
      raw.prepare('INSERT INTO role_members (role_id, user_id, org_id, expires_at, added_at) VALUES (?, ?, ?, ?, ?)').run(roleId, userId, ORG, expires, now);
    }
    personal.forEach(([type, selector, target, level, namespaces, expires, prefix], i) => {
      raw.prepare(
        `INSERT INTO resource_grants (id, org_id, principal_type, principal_id, resource_type, selector, resource_id, tag, namespaces, level, expires_at, created_at)
         VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        prefix === 'legacy-all:' ? `legacy-all:${type}:${ORG}:${userId}` : `${userId}-p${i}`,
        ORG,
        userId,
        type,
        selector,
        selector === 'id' ? target : null,
        selector === 'tag' ? target : null,
        namespaces === 'bad' ? '{not json' : namespaces ? JSON.stringify(namespaces) : null,
        level,
        expires,
        now,
      );
    });
    // Per-member rows the pre-roles endpoints still write, mirrored by 0023's triggers at the base level
    if (mirrored) {
      raw.exec(`INSERT INTO member_server_access (org_id, user_id, server_id, expires_at, created_at) VALUES ('${ORG}', '${userId}', 's-bare', NULL, 'now')`);
      raw.exec(`INSERT INTO member_cluster_access (org_id, user_id, cluster_id, expires_at, created_at) VALUES ('${ORG}', '${userId}', 'k2', '${FUTURE}', 'now')`);
    }
    const rw = generateApiToken();
    const ro = generateApiToken();
    for (const [token, scopes] of [[rw, ['read', 'write']], [ro, ['read']]] as const) {
      getDb()
        .insert(apiTokens)
        .values({ id: `${userId}-${scopes.length}`, userId, name: 't', hashedToken: token.hashedToken, prefix: token.prefix, scopes: JSON.stringify(scopes) })
        .run();
    }
    members.push({ userId, role, status, tokens: { rw: rw.token, ro: ro.token } });
  };

  for (const role of BASE_ROLES) {
    for (const scope of SCOPES) {
      ROLE_SETS.forEach((roleSet, r) => {
        PERSONAL_SETS.forEach((personal, p) => add(role, scope, roleSet, personal, 'active', (r + p) % 2 === 1));
      });
      // Suspended: nothing, whatever they hold
      add(role, scope, ROLE_SETS[3]!, PERSONAL_SETS[1]!, 'suspended', true);
    }
  }
  // A member of the other org only, holding o1's roles by mistake: still nothing in o1
  raw.exec(`INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('stranger', 's@x.test', 's', 'now', 'now')`);
  raw.exec(`INSERT INTO memberships (user_id, org_id, role, joined_at) VALUES ('stranger', '${OTHER}', 'admin', 'now')`);
}

// ── What is compared ──────────────────────────────────────────────────────────

type Answers = Map<string, unknown>;

/** Every resource decision for one member, from a resolved access. */
function resourceAnswers(access: ResolvedAccess, answers: Answers, prefix: string) {
  for (const type of RESOURCE_TYPES) {
    for (const id of RESOURCES[type]) {
      for (const namespace of type === 'cluster' ? NAMESPACES : [undefined]) {
        const found = levelForAccess(access, type, id, { namespace });
        answers.set(`${prefix}level ${type}/${id}/${namespace ?? '*'}`, found ? { level: found.level, namespaces: found.namespaces } : null);
        for (const action of Object.keys(ACTION_LEVELS[type]) as ResourceAction[]) {
          const required = requiredLevel(type, action as ResourceAction<typeof type>);
          const status = !found ? 404 : meetsLevel(found.level, required) ? 200 : 403;
          answers.set(`${prefix}authorize ${type}/${id}/${namespace ?? '*'} ${action}`, status);
        }
      }
    }
    for (const level of ACCESS_LEVELS) {
      const ids = accessibleIdsFor(access, type, level);
      answers.set(`${prefix}ids ${type} ${level}`, ids.all ? 'all' : [...ids.ids].sort());
      answers.set(`${prefix}reachesAny ${type} ${level}`, reachesAnyFor(access, type, level));
    }
  }
}

/** The decisions as migration 0024's engine and the base role made them. */
function before(member: Member): Answers {
  const answers: Answers = new Map();
  for (const readOnly of [false, true]) {
    const access = legacyLoad(ORG, member.userId, readOnly);
    const prefix = readOnly ? 'ro ' : 'rw ';
    resourceAnswers(access, answers, prefix);
    // requireRole read req.role: the membership's role, viewer for read-only tokens
    const reqRole: Role = readOnly ? 'viewer' : access.role;
    answers.set(`${prefix}req.role`, access.active ? reqRole : null);
    answers.set(`${prefix}orgAdmin`, access.active && access.orgAdmin);
    const operatorBase = access.active && access.scope === 'all' && !readOnly && rank(access.role) >= rank('operator');
    for (const type of ['saved_command', 'cron_job'] as const) {
      answers.set(`${prefix}baseRoleAllows ${type}`, operatorBase);
      answers.set(`${prefix}mayCreate ${type}`, operatorBase || accessibleIdsFor(access, type, 'manage').all);
    }
    answers.set(`${prefix}isOwner`, access.active && access.role === 'owner' && !readOnly);
  }
  // SSO enforcement exempted owners by membership role, whatever the status
  answers.set('ssoOwner', member.role === 'owner');
  return answers;
}

/** The same decisions from the live engine after migration 0025. */
function after(member: Member): Answers {
  const answers: Answers = new Map();
  for (const readOnly of [false, true]) {
    const who: AccessSubject = readOnly
      ? { orgId: ORG, user: { id: member.userId, email: '', displayName: '' }, apiTokenReadOnly: true }
      : { orgId: ORG, userId: member.userId };
    const access = resolveAccess(who);
    const prefix = readOnly ? 'ro ' : 'rw ';
    resourceAnswers(access, answers, prefix);
    // And through the public entry points, which must say the same (read-write: the
    // read-only answers above come from the same resolution)
    for (const type of readOnly ? [] : RESOURCE_TYPES) {
      for (const id of RESOURCES[type]) {
        for (const namespace of type === 'cluster' ? NAMESPACES : [undefined]) {
          for (const action of Object.keys(ACTION_LEVELS[type]) as ResourceAction[]) {
            const result = authorize(who, type, id, action as ResourceAction<typeof type>, { namespace });
            expect(result.status, `${member.userId} ${prefix}${type}/${id}/${namespace ?? '*'} ${action}`).toBe(
              answers.get(`${prefix}authorize ${type}/${id}/${namespace ?? '*'} ${action}`),
            );
          }
        }
      }
      for (const level of ACCESS_LEVELS) {
        const ids = accessibleIds(who, type, level);
        expect(ids.all ? 'all' : [...ids.ids].sort()).toEqual(answers.get(`${prefix}ids ${type} ${level}`));
        expect(reachesAny(who, type, level)).toBe(answers.get(`${prefix}reachesAny ${type} ${level}`));
      }
    }
    const reqRole: Role = readOnly ? 'viewer' : access.role;
    answers.set(`${prefix}req.role`, access.active ? reqRole : null);
    answers.set(`${prefix}orgAdmin`, access.active && access.orgAdmin);
    for (const type of ['saved_command', 'cron_job'] as const) {
      answers.set(`${prefix}baseRoleAllows ${type}`, baseRoleAllows(who, type));
      answers.set(`${prefix}mayCreate ${type}`, mayCreate(who, type));
    }
    answers.set(`${prefix}isOwner`, isOwner(who));
  }
  answers.set('ssoOwner', isOrgOwner(ORG, member.userId));
  return answers;
}

/** A route per minimum role, behind the real requireAuth + requireRole. */
function gateApp(): FastifyInstance {
  const app = Fastify();
  app.addHook('preHandler', requireAuth);
  for (const minimum of ROLES) {
    app.get(`/gate/${minimum}`, { preHandler: requireRole(minimum) }, async (req) => ({ role: req.role }));
  }
  return app;
}

async function gates(app: FastifyInstance, member: Member): Promise<Record<string, number>> {
  const statuses: Record<string, number> = {};
  for (const [kind, token] of Object.entries(member.tokens)) {
    for (const minimum of ROLES) {
      const res = await app.inject({ method: 'GET', url: `/gate/${minimum}`, headers: { authorization: `Bearer ${token}` } });
      statuses[`${kind} ${minimum}`] = res.statusCode;
    }
  }
  return statuses;
}

/** What requireAuth + requireRole answered before: 403 when suspended, else by the membership's role (read-only tokens: viewer). */
function gatesBefore(member: Member): Record<string, number> {
  const statuses: Record<string, number> = {};
  const role = (ROLE_NAMES as readonly string[]).includes(member.role) ? member.role : 'viewer';
  for (const kind of ['rw', 'ro']) {
    for (const minimum of ROLES) {
      const effective = kind === 'ro' ? 'viewer' : role;
      statuses[`${kind} ${minimum}`] = member.status !== 'active' ? 403 : rank(effective) >= rank(minimum) ? 200 : 403;
    }
  }
  return statuses;
}

describe('migration 0025 keeps every member’s effective access', () => {
  const expected = new Map<string, Answers>();

  beforeAll(() => {
    apply(journal.entries.map((e) => e.tag).filter((t) => t < UNIFIED_TAG));
    seed();
    for (const member of members) expected.set(member.userId, before(member));
    apply([UNIFIED_TAG]);
  });

  it('covers every combination of base role, scope, custom roles and personal grants', () => {
    expect(members.length).toBe(BASE_ROLES.length * SCOPES.length * (ROLE_SETS.length * PERSONAL_SETS.length + 1));
    // The fixtures are not trivially equal: some members reach some things and not others
    const levels = new Set(members.map((m) => JSON.stringify(expected.get(m.userId)!.get('rw level server/s-bare/*'))));
    expect(levels.size).toBeGreaterThan(2);
  });

  it('decides every resource action, level, accessible set and base-role right as before', () => {
    let compared = 0;
    for (const member of members) {
      const was = expected.get(member.userId)!;
      const now = after(member);
      expect(now.size, member.userId).toBe(was.size);
      for (const [key, value] of was) {
        expect(now.get(key), `${member.userId} (${member.role}) ${key}`).toEqual(value);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(50_000);
  });

  it('answers every former requireRole gate as before, through requireAuth', async () => {
    const app = gateApp();
    await app.ready();
    for (const member of members) {
      expect(await gates(app, member), `${member.userId} (${member.role}, ${member.status})`).toEqual(gatesBefore(member));
    }
    await app.close();
  });

  it('gives nobody outside the org anything in it', () => {
    expect(resolveAccess({ orgId: ORG, userId: 'stranger' }).active).toBe(false);
    for (const type of RESOURCE_TYPES) expect(accessibleIds({ orgId: ORG, userId: 'stranger' }, type)).toEqual({ all: false, ids: [] });
  });

  it('turns base roles into the built-in roles, and role-scoped operators and viewers into "(modules only)" roles', () => {
    const held = (userId: string) =>
      getDb()
        .select({ roleId: roleMembers.roleId })
        .from(roleMembers)
        .where(eq(roleMembers.userId, userId))
        .all()
        .map((r) => r.roleId)
        .filter((id) => id.startsWith('builtin:') || id.startsWith('modules-only:'));
    for (const member of members) {
      const scope = getDb().select({ scope: memberships.scope }).from(memberships).where(eq(memberships.userId, member.userId)).get()!.scope;
      const base = ['owner', 'admin', 'operator'].includes(member.role) ? member.role : 'viewer';
      const id = scope === 'roles' && !['owner', 'admin'].includes(base) ? `modules-only:${ORG}:${base}` : `builtin:${ORG}:${base}`;
      expect(held(member.userId), member.userId).toEqual([id]);
    }
    // The custom role named like a built-in keeps its members and grants under a new name
    const renamed = getDb().select({ name: roles.name, system: roles.system }).from(roles).where(eq(roles.id, 'r-tag')).get();
    expect(renamed).toEqual({ name: 'Viewer (custom r-ta)', system: null });
    expect(getDb().select({ name: roles.name }).from(roles).where(eq(roles.id, `builtin:${ORG}:viewer`)).get()?.name).toBe(
      BUILT_IN_ROLE_DEFAULTS.viewer.name,
    );
  });
});
