-- Unified roles (unified roles spec §6): one kind of role, a named bundle of
-- module permissions and resource grants; a member's access is the union of
-- the roles they hold and their personal grants. Every org gets the built-in
-- roles Owner, Admin, Operator, Viewer and No access, and every member is
-- given the role(s) that reproduce exactly what their base role and scope
-- allowed. memberships.role and memberships.scope stay for one release, for
-- old API callers, and are no longer read for decisions.
--
-- What the built-in roles (and the roles generated for role-scoped members)
-- hold by default, as the triggers below create them. The same values are
-- BUILT_IN_ROLE_DEFAULTS / MODULES_ONLY_DEFAULTS in @smt/shared, which
-- "Reset to default" uses; migrations.test.ts keeps the two in step.
-- grant_level: the level of the role's "All …" grant on every resource type.
CREATE TABLE `role_defaults` (
	`key` text PRIMARY KEY NOT NULL,
	`system` text,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`module_permissions` text NOT NULL,
	`grant_level` text
);
--> statement-breakpoint
INSERT INTO `role_defaults` (`key`, `system`, `name`, `description`, `module_permissions`, `grant_level`) VALUES
	('owner', 'owner', 'Owner', 'Everything, including transferring ownership, backups and deleting the organization',
		'{"dashboard":"view","servers":"manage","containers":"manage","kubernetes":"manage","ftp":"manage","storage":"manage","cloud":"manage","saved_commands":"manage","cron_jobs":"manage","monitoring":"manage","diagnostics":"operate","ai":"manage","recordings":"manage","audit":"manage","ssh_keys":"manage","agents":"manage","team_members":"operate","team_roles":"manage","team_sign_in":"manage","settings":"manage"}',
		'manage'),
	('admin', 'admin', 'Admin', 'Every module and every resource, managed',
		'{"dashboard":"view","servers":"manage","containers":"manage","kubernetes":"manage","ftp":"manage","storage":"manage","cloud":"manage","saved_commands":"manage","cron_jobs":"manage","monitoring":"manage","diagnostics":"operate","ai":"manage","recordings":"manage","audit":"manage","ssh_keys":"manage","agents":"manage","team_members":"operate","team_roles":"manage","team_sign_in":"manage","settings":"manage"}',
		'manage'),
	('operator', 'operator', 'Operator', 'Operates every resource; AI Assistant and diagnostics',
		'{"dashboard":"view","servers":"operate","containers":"operate","kubernetes":"operate","ftp":"operate","storage":"operate","cloud":"operate","saved_commands":"manage","cron_jobs":"manage","monitoring":"operate","diagnostics":"operate","recordings":"view","ssh_keys":"view","team_members":"view","ai":"view"}',
		'operate'),
	('viewer', 'viewer', 'Viewer', 'Sees every resource',
		'{"dashboard":"view","servers":"view","containers":"view","kubernetes":"view","ftp":"view","storage":"view","cloud":"view","saved_commands":"view","cron_jobs":"view","monitoring":"operate","diagnostics":"view","recordings":"view","ssh_keys":"view","team_members":"view"}',
		'view'),
	('none', 'none', 'No access', 'Nothing beyond their own account', '{}', NULL),
	('modules-only:operator', NULL, 'Operator (modules only)', 'Operator features; resources only from other roles and grants',
		'{"dashboard":"view","servers":"operate","containers":"operate","kubernetes":"operate","ftp":"operate","storage":"operate","cloud":"operate","saved_commands":"operate","cron_jobs":"operate","monitoring":"operate","diagnostics":"operate","recordings":"view","ssh_keys":"view","team_members":"view","ai":"view"}',
		NULL),
	('modules-only:viewer', NULL, 'Viewer (modules only)', 'Viewer features; resources only from other roles and grants',
		'{"dashboard":"view","servers":"view","containers":"view","kubernetes":"view","ftp":"view","storage":"view","cloud":"view","saved_commands":"view","cron_jobs":"view","monitoring":"operate","diagnostics":"view","recordings":"view","ssh_keys":"view","team_members":"view"}',
		NULL);
--> statement-breakpoint
-- system: owner | admin | operator | viewer | none for the built-in roles
-- (id `builtin:<org>:<system>`), null for every other role. Roles generated
-- for role-scoped members have ids `modules-only:<org>:<base>`.
ALTER TABLE `roles` ADD `system` text;
--> statement-breakpoint
-- JSON {module: level}; a module left out is `none`. Null for custom roles
-- made before this migration (or by the pre-0025 editor): those enable, at
-- `view`, the resource modules of the types they have grants for, which is
-- what they did before (auth/access/resolve.ts).
ALTER TABLE `roles` ADD `module_permissions` text;
--> statement-breakpoint
-- The role new members get when none is picked (invites, SSO). Null = Viewer.
ALTER TABLE `organizations` ADD `default_role_id` text REFERENCES roles(id) ON DELETE set null;
--> statement-breakpoint
-- Built-in names are taken from now on; a custom role already called that
-- keeps its members and grants under a new name.
UPDATE `roles` SET `name` = `name` || ' (custom ' || substr(`id`, 1, 4) || ')'
WHERE `name` IN (SELECT `name` FROM `role_defaults`);
--> statement-breakpoint
INSERT INTO `roles` (`id`, `org_id`, `name`, `description`, `color`, `created_by`, `created_at`, `updated_at`, `system`, `module_permissions`)
SELECT 'builtin:' || o.`id` || ':' || d.`system`, o.`id`, d.`name`, d.`description`, NULL, 'system',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), d.`system`, d.`module_permissions`
FROM `organizations` o, `role_defaults` d
WHERE d.`system` IS NOT NULL;
--> statement-breakpoint
-- Admin, Operator and Viewer reach every resource of every type at their
-- level, as base roles did. Owner reaches everything without grants (it is
-- locked); No access reaches nothing.
INSERT INTO `resource_grants` (`id`, `org_id`, `principal_type`, `principal_id`, `resource_type`, `selector`, `resource_id`, `level`, `expires_at`, `granted_by`, `reason`, `created_at`)
SELECT 'builtin:' || o.`id` || ':' || d.`system` || ':' || t.`type`, o.`id`, 'role', 'builtin:' || o.`id` || ':' || d.`system`, t.`type`, 'all', NULL,
	d.`grant_level`, NULL, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `organizations` o, `role_defaults` d,
	(SELECT 'server' AS `type` UNION ALL SELECT 'cluster' UNION ALL SELECT 'ftp_connection' UNION ALL SELECT 'storage_connection'
		UNION ALL SELECT 'cloud_account' UNION ALL SELECT 'saved_command' UNION ALL SELECT 'cron_job') t
WHERE d.`system` IN ('admin', 'operator', 'viewer');
--> statement-breakpoint
UPDATE `organizations` SET `default_role_id` = 'builtin:' || `id` || ':viewer';
--> statement-breakpoint
-- Role-scoped operators and viewers kept their base role's features but only
-- the resources roles and grants gave them: a generated "<Base> (modules
-- only)" role per org, where someone needs it.
INSERT INTO `roles` (`id`, `org_id`, `name`, `description`, `color`, `created_by`, `created_at`, `updated_at`, `system`, `module_permissions`)
SELECT DISTINCT 'modules-only:' || m.`org_id` || ':' || CASE WHEN m.`role` = 'operator' THEN 'operator' ELSE 'viewer' END, m.`org_id`, d.`name`, d.`description`, NULL, 'system',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, d.`module_permissions`
FROM `memberships` m JOIN `role_defaults` d ON d.`key` = 'modules-only:' || CASE WHEN m.`role` = 'operator' THEN 'operator' ELSE 'viewer' END
WHERE m.`scope` = 'roles' AND m.`role` NOT IN ('owner', 'admin');
--> statement-breakpoint
-- Every member holds the role matching their base role and scope. Owners and
-- admins saw everything whatever their scope; unknown roles counted as viewer.
INSERT INTO `role_members` (`role_id`, `user_id`, `org_id`, `expires_at`, `added_by`, `added_at`)
SELECT CASE
		WHEN m.`scope` = 'roles' AND m.`role` NOT IN ('owner', 'admin')
			THEN 'modules-only:' || m.`org_id` || ':' || CASE WHEN m.`role` = 'operator' THEN 'operator' ELSE 'viewer' END
		ELSE 'builtin:' || m.`org_id` || ':' || CASE WHEN m.`role` IN ('owner', 'admin', 'operator') THEN m.`role` ELSE 'viewer' END
	END,
	m.`user_id`, m.`org_id`, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `memberships` m;
--> statement-breakpoint
-- A new org gets the built-in roles, and Viewer as its default role.
CREATE TRIGGER `organizations_built_in_roles` AFTER INSERT ON `organizations` BEGIN
	INSERT OR IGNORE INTO `roles` (`id`, `org_id`, `name`, `description`, `color`, `created_by`, `created_at`, `updated_at`, `system`, `module_permissions`)
	SELECT 'builtin:' || NEW.`id` || ':' || d.`system`, NEW.`id`, d.`name`, d.`description`, NULL, 'system',
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), d.`system`, d.`module_permissions`
	FROM `role_defaults` d WHERE d.`system` IS NOT NULL;
	INSERT OR IGNORE INTO `resource_grants` (`id`, `org_id`, `principal_type`, `principal_id`, `resource_type`, `selector`, `resource_id`, `level`, `expires_at`, `granted_by`, `reason`, `created_at`)
	SELECT 'builtin:' || NEW.`id` || ':' || d.`system` || ':' || t.`type`, NEW.`id`, 'role', 'builtin:' || NEW.`id` || ':' || d.`system`, t.`type`, 'all', NULL,
		d.`grant_level`, NULL, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	FROM `role_defaults` d,
		(SELECT 'server' AS `type` UNION ALL SELECT 'cluster' UNION ALL SELECT 'ftp_connection' UNION ALL SELECT 'storage_connection'
			UNION ALL SELECT 'cloud_account' UNION ALL SELECT 'saved_command' UNION ALL SELECT 'cron_job') t
	WHERE d.`system` IN ('admin', 'operator', 'viewer');
	UPDATE `organizations` SET `default_role_id` = 'builtin:' || NEW.`id` || ':viewer' WHERE `id` = NEW.`id` AND `default_role_id` IS NULL;
END;
--> statement-breakpoint
-- Until the team, invite and SSO routes assign roles themselves, whatever
-- they write to memberships.role / scope is turned into the matching role
-- here, as the migration did above: the member's built-in (or generated)
-- role follows their base role and scope; other roles they hold stay. Both
-- triggers read the row as it is now, so the order in which they and
-- 0023's scope mirror fire does not matter. Dropped once those writers move.
CREATE TRIGGER `memberships_role_sync_insert` AFTER INSERT ON `memberships` BEGIN
	DELETE FROM `role_members` WHERE `org_id` = NEW.`org_id` AND `user_id` = NEW.`user_id` AND (
		`role_id` IN ('builtin:' || NEW.`org_id` || ':owner', 'builtin:' || NEW.`org_id` || ':admin',
			'builtin:' || NEW.`org_id` || ':operator', 'builtin:' || NEW.`org_id` || ':viewer')
		OR `role_id` IN ('modules-only:' || NEW.`org_id` || ':operator', 'modules-only:' || NEW.`org_id` || ':viewer'));
	INSERT OR IGNORE INTO `roles` (`id`, `org_id`, `name`, `description`, `color`, `created_by`, `created_at`, `updated_at`, `system`, `module_permissions`)
	SELECT 'modules-only:' || m.`org_id` || ':' || CASE WHEN m.`role` = 'operator' THEN 'operator' ELSE 'viewer' END, m.`org_id`, d.`name`, d.`description`, NULL, 'system',
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, d.`module_permissions`
	FROM `memberships` m JOIN `role_defaults` d ON d.`key` = 'modules-only:' || CASE WHEN m.`role` = 'operator' THEN 'operator' ELSE 'viewer' END
	WHERE m.`user_id` = NEW.`user_id` AND m.`org_id` = NEW.`org_id` AND m.`scope` = 'roles' AND m.`role` NOT IN ('owner', 'admin');
	INSERT OR IGNORE INTO `role_members` (`role_id`, `user_id`, `org_id`, `expires_at`, `added_by`, `added_at`)
	SELECT r.`id`, m.`user_id`, m.`org_id`, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	FROM `memberships` m JOIN `roles` r ON r.`id` = CASE
			WHEN m.`scope` = 'roles' AND m.`role` NOT IN ('owner', 'admin')
				THEN 'modules-only:' || m.`org_id` || ':' || CASE WHEN m.`role` = 'operator' THEN 'operator' ELSE 'viewer' END
			ELSE 'builtin:' || m.`org_id` || ':' || CASE WHEN m.`role` IN ('owner', 'admin', 'operator') THEN m.`role` ELSE 'viewer' END
		END
	WHERE m.`user_id` = NEW.`user_id` AND m.`org_id` = NEW.`org_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `memberships_role_sync_update` AFTER UPDATE OF `role`, `scope` ON `memberships`
	WHEN OLD.`role` IS NOT NEW.`role` OR OLD.`scope` IS NOT NEW.`scope` BEGIN
	DELETE FROM `role_members` WHERE `org_id` = NEW.`org_id` AND `user_id` = NEW.`user_id` AND (
		`role_id` IN ('builtin:' || NEW.`org_id` || ':owner', 'builtin:' || NEW.`org_id` || ':admin',
			'builtin:' || NEW.`org_id` || ':operator', 'builtin:' || NEW.`org_id` || ':viewer')
		OR `role_id` IN ('modules-only:' || NEW.`org_id` || ':operator', 'modules-only:' || NEW.`org_id` || ':viewer'));
	INSERT OR IGNORE INTO `roles` (`id`, `org_id`, `name`, `description`, `color`, `created_by`, `created_at`, `updated_at`, `system`, `module_permissions`)
	SELECT 'modules-only:' || m.`org_id` || ':' || CASE WHEN m.`role` = 'operator' THEN 'operator' ELSE 'viewer' END, m.`org_id`, d.`name`, d.`description`, NULL, 'system',
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, d.`module_permissions`
	FROM `memberships` m JOIN `role_defaults` d ON d.`key` = 'modules-only:' || CASE WHEN m.`role` = 'operator' THEN 'operator' ELSE 'viewer' END
	WHERE m.`user_id` = NEW.`user_id` AND m.`org_id` = NEW.`org_id` AND m.`scope` = 'roles' AND m.`role` NOT IN ('owner', 'admin');
	INSERT OR IGNORE INTO `role_members` (`role_id`, `user_id`, `org_id`, `expires_at`, `added_by`, `added_at`)
	SELECT r.`id`, m.`user_id`, m.`org_id`, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	FROM `memberships` m JOIN `roles` r ON r.`id` = CASE
			WHEN m.`scope` = 'roles' AND m.`role` NOT IN ('owner', 'admin')
				THEN 'modules-only:' || m.`org_id` || ':' || CASE WHEN m.`role` = 'operator' THEN 'operator' ELSE 'viewer' END
			ELSE 'builtin:' || m.`org_id` || ':' || CASE WHEN m.`role` IN ('owner', 'admin', 'operator') THEN m.`role` ELSE 'viewer' END
		END
	WHERE m.`user_id` = NEW.`user_id` AND m.`org_id` = NEW.`org_id`;
END;
