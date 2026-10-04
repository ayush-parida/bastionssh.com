-- Custom roles (custom roles spec §3): named roles that bundle resources with
-- a level each, held by several members, plus personal grants. Everything
-- an operator or viewer may use outside their base role comes from
-- resource_grants: principal_type 'role' (every member of the role) or
-- 'user' (a personal grant). selector: id | all | tag (servers only).
-- level: view | operate | manage. Null expires_at = permanent.
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_org_name_idx` ON `roles` (`org_id`,`name`);
--> statement-breakpoint
CREATE TABLE `role_members` (
	`role_id` text NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`expires_at` text,
	`added_by` text,
	`added_at` text NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_members_role_user_idx` ON `role_members` (`role_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `role_members_org_user_idx` ON `role_members` (`org_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `role_members_expires_idx` ON `role_members` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `resource_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`selector` text DEFAULT 'id' NOT NULL,
	`resource_id` text,
	`tag` text,
	`namespaces` text,
	`level` text NOT NULL,
	`expires_at` text,
	`granted_by` text,
	`reason` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `resource_grants_principal_idx` ON `resource_grants` (`org_id`,`principal_type`,`principal_id`);
--> statement-breakpoint
CREATE INDEX `resource_grants_resource_idx` ON `resource_grants` (`resource_type`,`resource_id`);
--> statement-breakpoint
CREATE INDEX `resource_grants_expires_idx` ON `resource_grants` (`expires_at`);
--> statement-breakpoint
-- all | roles. Restricted members become role-scoped; server_access stays as
-- a mirror for one release.
ALTER TABLE `memberships` ADD `scope` text DEFAULT 'all' NOT NULL;
--> statement-breakpoint
UPDATE `memberships` SET `scope` = 'roles' WHERE `server_access` = 'restricted';
--> statement-breakpoint
-- Requests may ask for a role or a resource of any type; existing ones are servers.
ALTER TABLE `access_requests` ADD `resource_type` text DEFAULT 'server' NOT NULL;
--> statement-breakpoint
ALTER TABLE `access_requests` ADD `role_id` text REFERENCES roles(id) ON DELETE cascade;
--> statement-breakpoint
-- Existing per-member server and cluster grants become personal grants at the
-- member's base-role level (viewer → view, operator → operate), keeping their
-- expiry, grantor and reason. The ids are derived from the old rows so the
-- mirror triggers below can find them.
INSERT INTO `resource_grants` (`id`, `org_id`, `principal_type`, `principal_id`, `resource_type`, `selector`, `resource_id`, `level`, `expires_at`, `granted_by`, `reason`, `created_at`)
SELECT 'legacy-server:' || a.`org_id` || ':' || a.`user_id` || ':' || a.`server_id`, a.`org_id`, 'user', a.`user_id`, 'server', 'id', a.`server_id`,
	COALESCE((SELECT CASE m.`role` WHEN 'operator' THEN 'operate' WHEN 'admin' THEN 'manage' WHEN 'owner' THEN 'manage' ELSE 'view' END
		FROM `memberships` m WHERE m.`user_id` = a.`user_id` AND m.`org_id` = a.`org_id`), 'view'),
	a.`expires_at`, a.`granted_by`, a.`reason`, a.`created_at`
FROM `member_server_access` a;
--> statement-breakpoint
INSERT INTO `resource_grants` (`id`, `org_id`, `principal_type`, `principal_id`, `resource_type`, `selector`, `resource_id`, `level`, `expires_at`, `granted_by`, `reason`, `created_at`)
SELECT 'legacy-cluster:' || a.`org_id` || ':' || a.`user_id` || ':' || a.`cluster_id`, a.`org_id`, 'user', a.`user_id`, 'cluster', 'id', a.`cluster_id`,
	COALESCE((SELECT CASE m.`role` WHEN 'operator' THEN 'operate' WHEN 'admin' THEN 'manage' WHEN 'owner' THEN 'manage' ELSE 'view' END
		FROM `memberships` m WHERE m.`user_id` = a.`user_id` AND m.`org_id` = a.`org_id`), 'view'),
	a.`expires_at`, a.`granted_by`, a.`reason`, a.`created_at`
FROM `member_cluster_access` a;
--> statement-breakpoint
-- A restricted member was narrowed on servers and clusters only: FTP and
-- storage connections, cloud accounts, saved commands and cron jobs stayed
-- open to their base role. Role-scoped members see only what is granted, so
-- restricted operators and viewers keep exactly that as personal grants on
-- every resource of those types, at the base-role level (`legacy-` ids, so
-- they follow role changes like the grants above). Saved commands and cron
-- jobs still follow their servers. Admins can remove them like any grant.
INSERT INTO `resource_grants` (`id`, `org_id`, `principal_type`, `principal_id`, `resource_type`, `selector`, `resource_id`, `level`, `expires_at`, `granted_by`, `reason`, `created_at`)
SELECT 'legacy-all:' || t.`type` || ':' || m.`org_id` || ':' || m.`user_id`, m.`org_id`, 'user', m.`user_id`, t.`type`, 'all', NULL,
	CASE m.`role` WHEN 'operator' THEN 'operate' ELSE 'view' END,
	NULL, NULL, 'Kept from before custom roles', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `memberships` m,
	(SELECT 'ftp_connection' AS `type` UNION ALL SELECT 'storage_connection' UNION ALL SELECT 'cloud_account'
		UNION ALL SELECT 'saved_command' UNION ALL SELECT 'cron_job') t
WHERE m.`server_access` = 'restricted' AND m.`role` NOT IN ('admin', 'owner');
--> statement-breakpoint
-- Until the team and access-request routes write resource_grants themselves,
-- whatever they write to the old per-member tables is mirrored here, at the
-- member's base-role level (kept in step with role changes below), so the
-- access engine has one source. Dropped once those writers move over.
CREATE TRIGGER `member_server_access_mirror_insert` AFTER INSERT ON `member_server_access` BEGIN
	INSERT OR REPLACE INTO `resource_grants` (`id`, `org_id`, `principal_type`, `principal_id`, `resource_type`, `selector`, `resource_id`, `level`, `expires_at`, `granted_by`, `reason`, `created_at`)
	VALUES ('legacy-server:' || NEW.`org_id` || ':' || NEW.`user_id` || ':' || NEW.`server_id`, NEW.`org_id`, 'user', NEW.`user_id`, 'server', 'id', NEW.`server_id`,
		COALESCE((SELECT CASE m.`role` WHEN 'operator' THEN 'operate' WHEN 'admin' THEN 'manage' WHEN 'owner' THEN 'manage' ELSE 'view' END
			FROM `memberships` m WHERE m.`user_id` = NEW.`user_id` AND m.`org_id` = NEW.`org_id`), 'view'),
		NEW.`expires_at`, NEW.`granted_by`, NEW.`reason`, NEW.`created_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `member_server_access_mirror_update` AFTER UPDATE ON `member_server_access` BEGIN
	DELETE FROM `resource_grants` WHERE `id` = 'legacy-server:' || OLD.`org_id` || ':' || OLD.`user_id` || ':' || OLD.`server_id`;
	INSERT OR REPLACE INTO `resource_grants` (`id`, `org_id`, `principal_type`, `principal_id`, `resource_type`, `selector`, `resource_id`, `level`, `expires_at`, `granted_by`, `reason`, `created_at`)
	VALUES ('legacy-server:' || NEW.`org_id` || ':' || NEW.`user_id` || ':' || NEW.`server_id`, NEW.`org_id`, 'user', NEW.`user_id`, 'server', 'id', NEW.`server_id`,
		COALESCE((SELECT CASE m.`role` WHEN 'operator' THEN 'operate' WHEN 'admin' THEN 'manage' WHEN 'owner' THEN 'manage' ELSE 'view' END
			FROM `memberships` m WHERE m.`user_id` = NEW.`user_id` AND m.`org_id` = NEW.`org_id`), 'view'),
		NEW.`expires_at`, NEW.`granted_by`, NEW.`reason`, NEW.`created_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `member_server_access_mirror_delete` AFTER DELETE ON `member_server_access` BEGIN
	DELETE FROM `resource_grants` WHERE `id` = 'legacy-server:' || OLD.`org_id` || ':' || OLD.`user_id` || ':' || OLD.`server_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `member_cluster_access_mirror_insert` AFTER INSERT ON `member_cluster_access` BEGIN
	INSERT OR REPLACE INTO `resource_grants` (`id`, `org_id`, `principal_type`, `principal_id`, `resource_type`, `selector`, `resource_id`, `level`, `expires_at`, `granted_by`, `reason`, `created_at`)
	VALUES ('legacy-cluster:' || NEW.`org_id` || ':' || NEW.`user_id` || ':' || NEW.`cluster_id`, NEW.`org_id`, 'user', NEW.`user_id`, 'cluster', 'id', NEW.`cluster_id`,
		COALESCE((SELECT CASE m.`role` WHEN 'operator' THEN 'operate' WHEN 'admin' THEN 'manage' WHEN 'owner' THEN 'manage' ELSE 'view' END
			FROM `memberships` m WHERE m.`user_id` = NEW.`user_id` AND m.`org_id` = NEW.`org_id`), 'view'),
		NEW.`expires_at`, NEW.`granted_by`, NEW.`reason`, NEW.`created_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `member_cluster_access_mirror_update` AFTER UPDATE ON `member_cluster_access` BEGIN
	DELETE FROM `resource_grants` WHERE `id` = 'legacy-cluster:' || OLD.`org_id` || ':' || OLD.`user_id` || ':' || OLD.`cluster_id`;
	INSERT OR REPLACE INTO `resource_grants` (`id`, `org_id`, `principal_type`, `principal_id`, `resource_type`, `selector`, `resource_id`, `level`, `expires_at`, `granted_by`, `reason`, `created_at`)
	VALUES ('legacy-cluster:' || NEW.`org_id` || ':' || NEW.`user_id` || ':' || NEW.`cluster_id`, NEW.`org_id`, 'user', NEW.`user_id`, 'cluster', 'id', NEW.`cluster_id`,
		COALESCE((SELECT CASE m.`role` WHEN 'operator' THEN 'operate' WHEN 'admin' THEN 'manage' WHEN 'owner' THEN 'manage' ELSE 'view' END
			FROM `memberships` m WHERE m.`user_id` = NEW.`user_id` AND m.`org_id` = NEW.`org_id`), 'view'),
		NEW.`expires_at`, NEW.`granted_by`, NEW.`reason`, NEW.`created_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `member_cluster_access_mirror_delete` AFTER DELETE ON `member_cluster_access` BEGIN
	DELETE FROM `resource_grants` WHERE `id` = 'legacy-cluster:' || OLD.`org_id` || ':' || OLD.`user_id` || ':' || OLD.`cluster_id`;
END;
--> statement-breakpoint
-- A mirrored grant means "the base role, on this resource", as it did before:
-- it follows the member's role up and down.
CREATE TRIGGER `memberships_legacy_grant_level` AFTER UPDATE OF `role` ON `memberships` BEGIN
	UPDATE `resource_grants`
	SET `level` = CASE NEW.`role` WHEN 'operator' THEN 'operate' WHEN 'admin' THEN 'manage' WHEN 'owner' THEN 'manage' ELSE 'view' END
	WHERE `org_id` = NEW.`org_id` AND `principal_type` = 'user' AND `principal_id` = NEW.`user_id` AND substr(`id`, 1, 7) = 'legacy-';
END;
--> statement-breakpoint
-- server_access writers (the team routes) set the scope too.
CREATE TRIGGER `memberships_scope_mirror_insert` AFTER INSERT ON `memberships` WHEN NEW.`server_access` = 'restricted' BEGIN
	UPDATE `memberships` SET `scope` = 'roles' WHERE `user_id` = NEW.`user_id` AND `org_id` = NEW.`org_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `memberships_scope_mirror_update` AFTER UPDATE OF `server_access` ON `memberships` BEGIN
	UPDATE `memberships` SET `scope` = CASE NEW.`server_access` WHEN 'restricted' THEN 'roles' ELSE 'all' END
	WHERE `user_id` = NEW.`user_id` AND `org_id` = NEW.`org_id`;
END;
--> statement-breakpoint
-- Leaving an org ends the member's personal grants and role memberships there.
CREATE TRIGGER `memberships_access_cleanup` AFTER DELETE ON `memberships` BEGIN
	DELETE FROM `resource_grants` WHERE `org_id` = OLD.`org_id` AND `principal_type` = 'user' AND `principal_id` = OLD.`user_id`;
	DELETE FROM `role_members` WHERE `org_id` = OLD.`org_id` AND `user_id` = OLD.`user_id`;
END;
