-- Existing keys stay active: a key is only retired by a rotation that moved
-- its last server onto a new key.
ALTER TABLE `ssh_keys` ADD `retired_at` text;
--> statement-breakpoint
ALTER TABLE `ssh_keys` ADD `rotated_from_key_id` text;
--> statement-breakpoint
CREATE TABLE `key_rotations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`batch_id` text,
	`server_id` text,
	`server_name` text NOT NULL,
	`old_key_id` text NOT NULL,
	`old_fingerprint` text NOT NULL,
	`new_key_id` text,
	`new_fingerprint` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`step` text,
	`error` text,
	`warnings` text DEFAULT '[]' NOT NULL,
	`old_key_retired` integer DEFAULT false NOT NULL,
	`started_by` text NOT NULL,
	`created_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `key_rotations_org_idx` ON `key_rotations` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `key_rotations_server_idx` ON `key_rotations` (`server_id`,`status`);
