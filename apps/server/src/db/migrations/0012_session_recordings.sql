-- Terminal session recording. Existing orgs start recording (the default) but
-- without keystrokes, and keep recordings for 90 days.
ALTER TABLE `organizations` ADD `recording_enabled` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `organizations` ADD `recording_input` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `organizations` ADD `recording_retention_days` integer DEFAULT 90 NOT NULL;
--> statement-breakpoint
CREATE TABLE `session_recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`server_id` text,
	`server_name` text,
	`user_id` text NOT NULL,
	`kind` text DEFAULT 'terminal' NOT NULL,
	`source` text,
	`command` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`bytes` integer DEFAULT 0 NOT NULL,
	`file_path` text NOT NULL,
	`input_recorded` integer DEFAULT 0 NOT NULL,
	`truncated` integer DEFAULT 0 NOT NULL,
	`cols` integer DEFAULT 80 NOT NULL,
	`rows` integer DEFAULT 24 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `session_recordings_org_started_idx` ON `session_recordings` (`org_id`,`started_at`);
--> statement-breakpoint
CREATE INDEX `session_recordings_server_idx` ON `session_recordings` (`server_id`);
--> statement-breakpoint
CREATE INDEX `session_recordings_user_idx` ON `session_recordings` (`user_id`);
--> statement-breakpoint
CREATE TABLE `session_recording_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`recording_id` text NOT NULL,
	`at` real NOT NULL,
	`source` text NOT NULL,
	`command` text NOT NULL,
	`exit_code` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`recording_id`) REFERENCES `session_recordings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_recording_commands_recording_idx` ON `session_recording_commands` (`recording_id`);
