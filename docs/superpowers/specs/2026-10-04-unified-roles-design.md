# Unified Roles, Module Permissions and "No access" — Design

**Date:** 2026-10-04
**Status:** Approved (2026-10-04) — user chose "Build with ultracode" and editable built-ins with reset; the remaining §10 recommendations are adopted (see §10). Supersedes the two-layer model (base role + scope + custom roles) of `2026-10-04-custom-roles-design.md`. Requested by the user: the built-in roles (Owner, Admin, Operator, Viewer) conflict with the new custom roles; add a **No access** role; **hide a module when the member has no item in it**; make **every module configurable, including Team & Access**.

## 1. Problem

Today a member has a **base role** (owner/admin/operator/viewer) *and* a **scope** (`all`/`roles`) *and* any number of **custom roles**, and org-level features are gated by the base role alone (61 `requireRole(...)` gates, ~49 more `rank()/req.role` checks in 21 server files, 25 web files using `useHasRole`). Consequences:

- Two kinds of "role" with different powers appear side by side in the UI ("Viewer" + "Web team"); members ask which one wins.
- There is no way to give someone *nothing* — the lowest base role still sees every module.
- Team & Access, SSH keys, agents, audit, settings, SSO, backups etc. cannot be delegated; only base-role admins get them.
- Modules show up empty when a member has no items in them.

## 2. Decisions (recommended)

1. **One kind of role.** A role is a named bundle of **module permissions** + **resource grants**. A member holds **one or more roles**; their access is the **union**. No separate base role, no scope.
2. **Built-in roles are ordinary roles with defaults**, created per org and marked `system`:
   | Built-in | Default content | Editable | Deletable |
   | --- | --- | --- | --- |
   | **Owner** | Everything, including owner-only actions (§4.3) | No (locked) | No |
   | **Admin** | Every module at `manage`, every resource type `All … → manage` | Yes (with "Reset to default") | No |
   | **Operator** | Resource modules `operate`, AI Assistant, Recordings (own), Diagnostics; every resource type `All … → operate` | Yes | No |
   | **Viewer** | Resource modules `view`; every resource type `All … → view` | Yes | No |
   | **No access** | Nothing (account settings only) | No (empty by definition) | No |
   Custom roles (e.g. "Web team") use exactly the same editor. Any role can be cloned.
3. **"No access" is explicit.** A member with only *No access* (or with zero roles) can sign in, manage their own account (password, passkeys, sessions, backup codes, API tokens limited to nothing), and see a friendly "You don't have access to anything yet — ask an admin" page, with "Request access" if access requests are enabled. Default role for new invites/SSO users is an org setting (default **Viewer**, matching today).
4. **Module permissions** (§3) gate *features*; **resource grants** gate *items*. A resource module is **shown only if** the member can see at least one item in it **or** may create items there; otherwise it is hidden from navigation, dashboard widgets, search and AI context, and its routes answer 404.
5. **Delegation is safe:** a member can only grant, assign or edit permissions that they themselves hold at the same or higher level (no self-escalation via Team & Access). Owner-only actions stay with Owners. At least one Owner always remains.
6. **Migration preserves today's effective access exactly** (§6), proven by an equivalence test on every member before/after.
7. **API tokens** inherit the owner's union; read-scoped tokens cap at `view`.
8. **Next migration is 0025.**

## 3. Modules

Each role sets a level per module: `none` · `view` · `operate` · `manage`. Meaning by module kind:

### 3.1 Resource modules
Servers (incl. Terminal, Files/SFTP, Docker tab, Health), Containers (fleet), Kubernetes, FTP, Object Storage, Cloud Accounts, Saved Commands, Cron Jobs.

- Item-level access comes from **resource grants** (existing engine: specific item, `All …`, server `tag:`, cluster namespaces; `view`/`operate`/`manage`).
- The module level adds **feature** rights not tied to an item: `manage` = may **create** new items (add server, add cluster, add connection…) and change module-wide settings (e.g. Docker/Kubernetes org toggles); `operate`/`view` = no creation. `none` = module off for this role even if grants exist (lets an admin park grants without enabling the module).
- Visibility rule: module enabled by some role **and** (≥ 1 visible item **or** module `manage`).

### 3.2 Org modules
| Module | view | operate | manage |
| --- | --- | --- | --- |
| Dashboard | Shown (content limited to visible items) | — | — |
| Monitoring & Alerts | See alerts for visible servers/clusters | Acknowledge | Alert rules, notification channels |
| DNS Lookup / Diagnostics | Run lookups | Diagnose with login | — |
| AI Assistant | Chat (tools still per-resource) | — | AI provider settings |
| Recordings | Own recordings | All recordings of visible resources | Delete, retention, recording settings |
| Audit Log | View | Export | Retention, forwarding |
| SSH Keys | List | Use in forms | Create/import/rotate/delete |
| Agents | List/status | — | Create/revoke/assign |
| Team & Access | See members | Invite, suspend/reactivate, sign-out, password-reset (for members whose roles ⊆ own) | Edit roles, assign roles, grants, access requests approval, SSO, passkey policy, sign-in security |
| Settings (org) | — | — | Org name, default role, backups, Docker/Kubernetes org settings |

Fine-grained Team & Access is split into three toggles inside the module (members, roles, sign-in & SSO) so an org can delegate "invite people" without "edit roles".

## 4. Authorization

### 4.1 Engine changes (`apps/server/src/auth/access/`)
- `resolve.ts` loads the member's roles (unexpired memberships), unions module levels and resource grants (role grants + personal grants).
- New `requireModule(module, level)` preHandler replaces `requireRole(...)`; `moduleLevel(subject, module)`; `visibleModules(subject)` (applies the visibility rule with cheap `EXISTS` queries per resource type).
- Every `rank()/req.role` check is replaced by a module or resource check; `req.role` is removed from the request type to make leftovers a compile error. `useHasRole` in the web is replaced by `useModule(module, level)` and `useAccessLevels`.
- Resource checks unchanged in semantics: no visibility → 404, visible but insufficient → 403.

### 4.2 Delegation guard
For any write in Team & Access (assign role, edit role, grant, approve request, invite with role): the actor's effective permission set must be ⊇ the permissions being granted, per module and per resource selector (an actor with `Servers tagged web → manage` can grant `tag:web` but not `All servers`). Owners bypass. Tested exhaustively.

### 4.3 Owner-only actions
Transfer/assign Owner, remove an Owner, delete the organization, download database backups, change instance-wide settings, and edit the Owner role (locked). Last-Owner protection stays.

## 5. Web

- **Roles tab** lists built-ins first (badge "Built-in"), then custom roles. Editor has two sections: **Modules** (a grid of modules × level with plain-language hints, Team & Access sub-toggles) and **Resources** (existing picker). "Reset to default" on built-ins; "Clone".
- **Members**: a multi-select of roles per member (chips), replacing the base-role dropdown and the scope toggle. Effective access panel adds a **Modules** section ("Team & Access: invite members — via Team leads").
- **Navigation** built from `GET /api/me/modules` (visible modules + levels). Hidden modules vanish from the sidebar, dashboard, command palette and deep links (404 page with "Request access").
- **No-access home** page as in §2.3.
- Invite and SSO forms: pick roles (default from org setting).

## 6. Migration (`0025_unified_roles`)

1. Create built-in roles per org with the default content above (`roles.system = 'owner'|'admin'|'operator'|'viewer'|'none'`, `module_permissions` JSON column on `roles`).
2. Members with scope `all`: add membership in the built-in matching their base role.
3. Members with scope `roles`: add membership in a generated system-derived role **"<Base> (modules only)"** — the base role's module permissions **without** the `All …` resource grants — plus their existing custom roles and personal grants (including `legacy-all` grants). Generated roles are ordinary editable roles.
4. `memberships.role` and `memberships.scope` stay readable for one release (compat for old API callers) but are no longer used for decisions; old endpoints (`PATCH member role`, scope, `/members/:id/access`) map onto role assignments.
5. Equivalence test: for every member in fixture orgs (all combinations of base role × scope × custom roles × personal grants), `authorize` for every module action and every resource action is identical before and after; a dry-run on a copy of the newest real backup reports zero differences.

## 7. Security

- Default-deny everywhere; module `none` → routes 404 and nav hidden.
- No self-escalation (§4.2); every role/assignment change audited with before/after and the delegation check result.
- Removing a role or module level triggers `revokeLiveAccess` for lost resources and closes module-scoped live features (e.g. AI streams when AI Assistant becomes `none`, audit export streams).
- Schedulers/workers acting for a user (cron, saved-command runs, AI) re-check module + resource access at run time.
- SSO group→role mapping (if configured) can only assign roles the SSO configurer could assign (§4.2).

## 8. Testing

- Unit: union rules, visibility rule, delegation guard (matrix of actor/target permission sets), built-in defaults.
- Route sweep: an automated test enumerates every registered route and asserts each is guarded by `requireModule`/resource checks (no `requireRole` left), and that a **No access** member gets 404 on every non-account route.
- Module matrix: for each module × level, allowed/denied actions.
- Migration equivalence (§6.5) + real-backup dry run.
- Playwright: No access member sees only the empty home + account; a "Team leads" custom role can invite members and assign only roles ⊆ their own; hidden modules disappear from the sidebar when the last item grant is removed; built-in Viewer edited to drop Kubernetes hides it for all viewers.

## 9. Effort

| Part | Rough size |
| --- | --- |
| Model, migration, built-ins, equivalence tests | 3 days |
| Replace 61 `requireRole` + ~49 `rank/req.role` checks with module/resource checks | 3–4 days |
| Delegation guard + Team & Access split | 2 days |
| Web: roles editor modules grid, member role chips, nav/visibility, No-access home, replace 25 `useHasRole` uses | 3–4 days |
| Route sweep test, Playwright, docs | 2 days |

## 10. Decisions (resolved open questions)

1. **Built-ins:** Admin, Operator and Viewer are editable org-wide with "Reset to default"; Owner and No access are locked (user's choice).
2. **Default role for new members:** Viewer (today's behaviour), configurable per org.
3. **Team & Access split** into members / roles / sign-in & SSO toggles: yes.
4. **Module `none` with grants present:** the module stays hidden and its routes 404; grants are kept ("parked").
5. **`memberships.role` / `memberships.scope`:** kept read-only for one release for API compatibility, removed in a later migration (not in this change).
