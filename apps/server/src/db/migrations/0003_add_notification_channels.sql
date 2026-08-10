CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`encrypted_url` text NOT NULL,
	`target_hint` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`min_severity` text DEFAULT 'warning' NOT NULL,
	`notify_on_resolve` integer DEFAULT true NOT NULL,
	`last_status` text,
	`last_error` text,
	`last_sent_at` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_channels_org_idx` ON `notification_channels` (`org_id`,`enabled`);
