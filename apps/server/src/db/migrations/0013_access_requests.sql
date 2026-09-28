-- Server grants can be time-bound. Existing grants have no expiry (permanent),
-- and nobody is recorded as having granted them.
ALTER TABLE `member_server_access` ADD `expires_at` text;
--> statement-breakpoint
ALTER TABLE `member_server_access` ADD `granted_by` text;
--> statement-breakpoint
ALTER TABLE `member_server_access` ADD `reason` text;
--> statement-breakpoint
CREATE INDEX `member_server_access_expires_idx` ON `member_server_access` (`expires_at`);
--> statement-breakpoint
-- Whether restricted members may see the names of servers they cannot use, so
-- they can ask for access. On by default; names only, never hosts or tags.
ALTER TABLE `organizations` ADD `restricted_see_server_names` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- Longest access a member may ask for, in minutes (default 8 hours).
ALTER TABLE `organizations` ADD `access_request_max_minutes` integer DEFAULT 480 NOT NULL;
--> statement-breakpoint
CREATE TABLE `access_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`server_ids` text NOT NULL,
	`reason` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`approved_minutes` integer,
	`decided_by` text,
	`decided_at` text,
	`decision_note` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `access_requests_org_status_idx` ON `access_requests` (`org_id`,`status`);
--> statement-breakpoint
CREATE INDEX `access_requests_user_idx` ON `access_requests` (`user_id`);
