CREATE TABLE `cloud_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`encrypted_credentials` text NOT NULL,
	`credential_hint` text NOT NULL,
	`regions` text DEFAULT '[]' NOT NULL,
	`default_username` text DEFAULT 'root' NOT NULL,
	`default_key_id` text,
	`auto_import` integer DEFAULT true NOT NULL,
	`sync_enabled` integer DEFAULT true NOT NULL,
	`last_sync_at` text,
	`last_status` text,
	`last_error` text,
	`last_summary` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_key_id`) REFERENCES `ssh_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cloud_accounts_org_idx` ON `cloud_accounts` (`org_id`);
--> statement-breakpoint
ALTER TABLE `servers` ADD `cloud_account_id` text REFERENCES cloud_accounts(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `servers` ADD `cloud_provider` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `cloud_instance_id` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `cloud_region` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `cloud_state` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `cloud_synced_at` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `servers_cloud_instance_idx` ON `servers` (`cloud_account_id`,`cloud_instance_id`);
