ALTER TABLE `memberships` ADD `status` text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE `memberships` ADD `suspended_at` text;
--> statement-breakpoint
ALTER TABLE `memberships` ADD `suspended_by` text;
--> statement-breakpoint
ALTER TABLE `memberships` ADD `server_access` text DEFAULT 'all' NOT NULL;
--> statement-breakpoint
-- Nothing stopped a user being added to the same org twice. Keep one row per
-- user and org so the unique index below can be created on existing data: the
-- highest-ranked (owner > admin > operator > viewer), then the oldest, so an
-- owner is never demoted and an org never loses its owner by this cleanup.
DELETE FROM `memberships` WHERE `rowid` NOT IN (
	SELECT `keep_rowid` FROM (
		SELECT `rowid` AS `keep_rowid`, ROW_NUMBER() OVER (
			PARTITION BY `user_id`, `org_id`
			ORDER BY CASE `role`
				WHEN 'owner' THEN 4
				WHEN 'admin' THEN 3
				WHEN 'operator' THEN 2
				WHEN 'viewer' THEN 1
				ELSE 0
			END DESC, `joined_at` ASC, `rowid` ASC
		) AS `rn`
		FROM `memberships`
	) WHERE `rn` = 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_user_org_idx` ON `memberships` (`user_id`,`org_id`);
--> statement-breakpoint
CREATE TABLE `member_server_access` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`server_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_server_access_idx` ON `member_server_access` (`org_id`,`user_id`,`server_id`);
--> statement-breakpoint
CREATE INDEX `member_server_access_server_idx` ON `member_server_access` (`server_id`);
--> statement-breakpoint
CREATE TABLE `password_resets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `password_resets_token_hash_unique` ON `password_resets` (`token_hash`);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `created_at` text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- Sessions that predate tracking get "now" rather than an empty string.
UPDATE `sessions` SET `created_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `created_at` = '';
--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_seen_at` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `ip_address` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `user_agent` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `active_org_id` text REFERENCES organizations(id) ON DELETE set null;
