# Custom Roles and Resource Access — Design

**Date:** 2026-10-04
**Status:** Approved (2026-10-04). The user chose **custom roles** (named roles that bundle resources with a permission level each, several roles per user) covering **servers & clusters, FTP/SFTP connections, object storage & cloud accounts, saved commands & cron jobs**, and asked to proceed with the recommendations in §13 without further questions.

## 1. Goal

Let admins say "the **Web team** can operate `web-1`, `web-2` and every server tagged `frontend`, view the `shop` namespace on `shop-prod`, and use the `webbeasyit` SFTP connection" — and then just add people to the Web team. Anyone can see *why* someone has access, and access disappears everywhere the moment it is removed.

Example:

```
Role: Web team
  Servers     web-1, web-2, tag:frontend   → Operate
  Clusters    shop-prod (ns: shop)         → View
  FTP/SFTP    webbeasyit (PaulMoon)        → Operate
  Storage     assets-bucket                → View
Members: alice, bob

alice = Viewer (org-wide, scope: roles only) + Web team
  → sees only those resources; can open terminals on web-1/web-2
```

## 2. Assumptions and decisions

1. **Two layers.** Every member keeps a **base role** (viewer / operator / admin / owner) and a **scope**:
   - `all` — the base role applies to every resource (today's default; no behaviour change for existing members).
   - `roles` — the member sees **only** resources granted through their custom roles (and personal grants); the base role still controls org-level features (e.g. viewers cannot open Team settings).
   Owners and admins always have `manage` on everything; custom roles are for everyone else.
2. **Three resource levels:** `view`, `operate`, `manage` (§5 maps them to concrete actions per resource type). A custom role **can raise** a member above their base role on its resources (a viewer in "Web team" with `operate` can open terminals on those servers) — that is the point of the feature.
3. **Effective level** on a resource = the highest of: base-role level (only when scope is `all`), every custom role the member holds that covers the resource, and any personal grant. Never more than `manage`; org-admin-only features (team, SSO, backups, agents, SSH keys, AI providers, notification channels, audit forwarding) stay base-role-only.
4. **Selectors, not just IDs.** A role entry targets a specific resource, **all resources of a type**, or (for servers) **a tag** (`tag:frontend`, evaluated live — a newly tagged server is covered immediately). For clusters an entry can narrow to **namespaces**.
5. **Personal grants stay**, unified with role grants: today's `member_server_access` / `member_cluster_access` rows (with expiry) and time-limited access requests become grants whose principal is the user. Role memberships can also expire (temporary on-call).
6. **One authorization engine.** `authorize(subject, type, resourceId, action)` and `accessibleFilter(subject, type, column)` replace the internals of `auth/server-access.ts` and `auth/cluster-access.ts` (whose exported functions remain as thin wrappers so the ~40 call sites keep working). Results are memoized per request.
7. **Dependent objects follow their parent:** Docker on a server, recordings of a server, diagnostics, host keys and key rotation, health/alerts, terminal and SFTP follow **server** access; Kubernetes views/actions follow **cluster (+namespace)** access; cron runs follow the cron job **and** its server; running a saved command needs `operate` on the command **and** on each target server.
8. **Revocation is immediate:** any role edit, role delete, membership change, scope change or grant expiry recomputes the member's accessible sets and calls `revokeLiveAccess` with `keepServerIds` / `keepClusterIds` (and the new keep sets for other types), closing terminals, SFTP/FTP sessions, Docker/Kubernetes streams and shells, and AI streams that lost access.
9. **API tokens inherit their owner's roles**; read-scoped tokens cap every level at `view`.
10. **Next migration is 0023.**

## 3. Data model (migration `0023_custom_roles`)

- `roles`: `id`, `org_id`, `name` (unique per org), `description`, `color`, `created_by`, `created_at`, `updated_at`.
- `role_members`: `role_id`, `user_id`, `org_id`, `expires_at` (null = permanent), `added_by`, `added_at`; unique (`role_id`, `user_id`).
- `resource_grants`: `id`, `org_id`, `principal_type` (`'role' | 'user'`), `principal_id`, `resource_type` (`'server' | 'cluster' | 'ftp_connection' | 'storage_connection' | 'cloud_account' | 'saved_command' | 'cron_job'`), `selector` (`'id' | 'all' | 'tag'`), `resource_id` (null unless `id`), `tag` (null unless `tag`), `namespaces` (JSON, clusters only, null = all), `level` (`'view' | 'operate' | 'manage'`), `expires_at`, `granted_by`, `reason`, `created_at`. Indexes on (`org_id`, `principal_type`, `principal_id`) and (`resource_type`, `resource_id`).
- `memberships.scope` (`'all' | 'roles'`), backfilled from `server_access` (`restricted` → `roles`). `server_access` is kept for one release as a read-only mirror, then dropped.
- Data migration: every `member_server_access` / `member_cluster_access` row becomes a `resource_grants` row (`principal_type='user'`, level from the member's base role: viewer → view, operator → operate), preserving `expires_at`, `granted_by`, `reason`. Old tables are kept (unused) for one release so rollback is possible.
- `access_requests` gains `resource_type` and `role_id` (request a role, or a resource) — existing rows are servers.

## 4. Authorization engine (`apps/server/src/auth/access/`)

| File | Responsibility |
| --- | --- |
| `levels.ts` | Level order, base-role → level mapping, per-type action → required level (§5). |
| `resolve.ts` | Load the member's scope, base role, active role memberships and grants (user + role principals, unexpired) once per request; compute per-type sets: `all`, explicit ids, tags, cluster namespaces. |
| `authorize.ts` | `authorize(subject, type, id, action)` → `{ ok, level, via: [{ kind: 'base' | 'role' | 'grant', name }] }`; `levelFor(...)`; 404 semantics for no access. |
| `filter.ts` | `accessibleFilter(subject, type, column)` (SQL), `filterAccessible(...)` (in memory), tag-aware for servers. |
| `explain.ts` | "Why does alice have access to web-1?" — used by the UI and the access checker. |
| `revoke.ts` | Diff old vs new accessible sets and call `revokeLiveAccess` with keep sets. |

Existing helpers (`canAccessServer`, `accessibleServerFilter`, `serverScope`, cluster equivalents, Docker/Kube permission matrices) are re-implemented on top of this engine; their signatures stay so call sites change only where a new action check is needed.

## 5. Levels per resource type

| Type | view | operate | manage |
| --- | --- | --- | --- |
| Server | See it, health, metrics, host-key status, Docker lists/status, recordings of own sessions | Terminal, SFTP read/write, run commands, Docker logs/stats/actions/exec (subject to org Docker toggles), diagnostics with login | Edit server, host keys (pin/accept/forget), key rotation, Docker remove/prune/env reveal, delete server |
| Cluster (+ns) | Map, graph, workloads, events, diagnoses | Logs, YAML, scale/restart/delete-pod/exec (subject to org Kube toggles), Explain | Rollback, cordon, cluster settings/credentials, impersonation toggle |
| FTP/SFTP connection | See it | Browse, upload, download, rename, delete files, test | Edit, host key, delete connection |
| Storage connection | See it, list buckets/objects | Upload, download, delete objects | Edit, delete connection |
| Cloud account | See it, last sync, instances | Trigger sync | Edit credentials, delete |
| Saved command | See it | Run (also needs `operate` on each target server) | Edit, delete |
| Cron job | See it, run history | Run now, enable/disable | Edit, delete (also needs `operate` on its server to create/move) |

Org toggles (Docker `operatorsCanExec`/`operatorsCanRemove`/`allowPrune`, Kubernetes `operatorsCan*`) apply to `operate`; `manage` implies them.

## 6. API

- Roles (admin): `GET/POST /api/team/roles`, `GET/PATCH/DELETE /api/team/roles/:id`, `PUT /api/team/roles/:id/grants` (replace the grant list atomically), `POST/DELETE /api/team/roles/:id/members` (with optional `expiresAt`).
- Members (admin): `PATCH /api/team/members/:userId` gains `scope`; `GET /api/team/members/:userId/access` returns roles, personal grants and the effective access per type; `PUT …/grants` for personal grants (replaces today's server/cluster access endpoints, which stay as compatible aliases for one release).
- Access checker (admin): `GET /api/team/access/explain?userId=&type=&id=` → level + reasons; `GET /api/team/access/resource?type=&id=` → who has access and via what.
- Access requests: members can request a **role** or a **resource** (type + id + level + duration); approval creates a temporary role membership or personal grant.
- Every list endpoint for the seven types filters with `accessibleFilter`; every by-id route uses `authorize` (404 when no access, 403 when visible but the action needs a higher level).

## 7. Web

- **Team & Access → Roles** tab: role list (name, colour, member count, resource summary chips). Role editor:
  - **Resources** section per type with a searchable picker: specific items, "All servers", or "Servers tagged …" (tag autocomplete, live count of matching servers); clusters with optional namespace chips; a level dropdown per entry.
  - **Members** section with add/remove and optional expiry.
  - A **preview**: "Members of this role will be able to: open terminals on 3 servers (web-1, web-2, edge-1 via tag), view namespace shop on shop-prod, …".
- **Member detail**: base role, scope toggle ("All resources" / "Only resources from roles"), roles with expiry, personal grants, and an **Effective access** panel listing each resource with its level and where it comes from (badges "via Web team", "personal, expires in 3h").
- **Resource pages** (server, cluster, connections, commands, cron jobs): a **Who has access** panel for admins.
- **Access checker**: pick a user and a resource → level and reasons.
- Non-admins see only what they can access; buttons the level does not allow are hidden (the server enforces regardless).

## 8. Security

1. Default-deny for `roles` scope; owners/admins unaffected; owners cannot be given `roles` scope.
2. Only admins/owners manage roles and grants; an admin cannot add members to roles in a way that affects owners' org-level rights (roles never grant org-admin features).
3. Tag selectors are evaluated at check time, so tagging a server is a privileged action: changing server tags requires `manage` on that server, and the audit row records which roles' coverage changed.
4. Every change to roles, grants, memberships and scope is audited with before/after; access checks themselves are not audited.
5. Revocation is computed and applied in the same request that changes access (§2.8), and also by the existing expiry sweep for expiring grants and role memberships.
6. Caching: per-request only; no cross-request cache, so changes apply on the next request.
7. Read-only API tokens cap levels at `view`; SSO sessions follow the same membership/roles.

## 9. Performance

Resolution loads at most a few small queries per request (membership, role memberships, grants). Server tag selectors use a JSON `tags` match in SQL. Lists are filtered in SQL, not in memory, wherever the table has the resource id. Target: < 2 ms added per request for orgs with 100 roles and 1 000 grants (benchmarked in tests).

## 10. Testing

- **Unit:** level resolution (base + roles + grants, expiry, scope), tag and namespace selectors, `explain` reasons, revoke diff.
- **Route matrix:** for each of the seven resource types, a table-driven test asserting list visibility and every action at view/operate/manage, through roles and through personal grants, for scope `all` and `roles`, plus 404 vs 403 semantics.
- **Regression:** the full existing suite (server-access, cluster-access, Docker, Kubernetes, SFTP, FTP, storage, cloud, commands, cron, recordings, AI tools, diagnostics) must pass unchanged; existing per-member grants migrate and behave identically.
- **Migration:** existing restricted members with server and cluster grants (with and without expiry) upgrade to `roles` scope with equivalent personal grants; members with `all` see no change.
- **Revocation:** removing a member from a role closes their terminal/SFTP/Docker/Kube sessions on the lost resources only.
- **Playwright:** create a role with a tag selector and a cluster namespace, add a member, sign in as that member and see only those resources; access checker shows the reason.

## 11. Rollout

1. Engine + migration + route enforcement for all seven types with no UI change (existing restricted members keep working through the migrated personal grants).
2. Roles UI, member detail, access checker, who-has-access panels.
3. Access requests for roles and non-server resources.

## 12. Effort

| Part | Rough size |
| --- | --- |
| Engine, migration, wrappers for existing helpers | 3–4 days |
| Enforcement across seven resource types (routes, lists, AI tools, schedulers) | 3–4 days |
| Roles UI, member detail, effective access, checker | 3 days |
| Access requests extension, revocation wiring, tests | 2–3 days |

## 13. Decisions (resolved open questions)

1. **Roles can raise a member above their base role, on the role's resources only.** Org-admin features are never granted by roles.
2. **Base roles unchanged:** viewer/operator/admin/owner stay; role-scoped members keep their base role for org-level features, and roles add resource levels on top. No new "Member" base role.
3. **Tag selectors included** for servers, evaluated live; changing a server's tags requires `manage` on that server and is audited with the affected roles.
4. **Kubernetes namespace narrowing included** per role entry and per personal grant.
5. **Old per-member access endpoints** (`/members/:userId/access`, cluster access) stay as compatible aliases for one release, backed by personal grants.
