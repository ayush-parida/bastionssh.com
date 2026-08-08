ALTER TABLE `servers` ADD `monitoring_enabled` integer DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE `server_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`server_id` text NOT NULL,
	`collected_at` text NOT NULL,
	`status` text NOT NULL,
	`latency_ms` real,
	`uptime_seconds` real,
	`load_1` real,
	`load_5` real,
	`load_15` real,
	`cpu_cores` integer,
	`cpu_percent` real,
	`cpu_total_jiffies` real,
	`cpu_idle_jiffies` real,
	`mem_total_kb` real,
	`mem_used_kb` real,
	`swap_total_kb` real,
	`swap_used_kb` real,
	`disk_total_kb` real,
	`disk_used_kb` real,
	`process_count` integer,
	`logged_in_users` integer,
	`disks` text,
	`error` text,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `server_metrics_server_time_idx` ON `server_metrics` (`server_id`,`collected_at`);
--> statement-breakpoint
CREATE TABLE `server_health` (
	`server_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_checked_at` text,
	`last_online_at` text,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`latency_ms` real,
	`uptime_seconds` real,
	`cpu_percent` real,
	`mem_percent` real,
	`disk_percent` real,
	`load_1` real,
	`cpu_cores` integer,
	`os_name` text,
	`kernel` text,
	`hostname` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `server_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`server_id` text NOT NULL,
	`type` text NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`message` text NOT NULL,
	`value` real,
	`threshold` real,
	`opened_at` text NOT NULL,
	`resolved_at` text,
	`acknowledged_at` text,
	`acknowledged_by` text,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `server_alerts_open_idx` ON `server_alerts` (`server_id`,`type`,`resolved_at`);
