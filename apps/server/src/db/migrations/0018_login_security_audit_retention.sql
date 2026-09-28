-- Where each account has signed in from: a hash of the browser/OS family and
-- the client's /24 (IPv6 /48). A sign-in from one not seen before emails the owner.
CREATE TABLE `user_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_hash` text NOT NULL,
	`label` text NOT NULL,
	`ip_prefix` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_devices_user_hash_idx` ON `user_devices` (`user_id`,`device_hash`);
--> statement-breakpoint
-- Failed password sign-ins per account, keyed by an HMAC of the email typed so an
-- address with no account behaves exactly like one with an account.
CREATE TABLE `login_failures` (
	`account_key` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`window_started_at` text NOT NULL,
	`locked_until` text,
	`lockouts` integer DEFAULT 0 NOT NULL,
	`last_failure_at` text NOT NULL,
	`notified_at` text
);
--> statement-breakpoint
-- Existing organizations keep a year of audit history, like new ones.
ALTER TABLE `organizations` ADD `audit_retention_days` integer DEFAULT 365 NOT NULL;
--> statement-breakpoint
-- At most one audit forwarding target (syslog or webhook) per organization.
CREATE TABLE `audit_forwarders` (
	`org_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`encrypted_config` text NOT NULL,
	`target_hint` text NOT NULL,
	`cursor_created_at` text NOT NULL,
	`cursor_rowid` integer DEFAULT 0 NOT NULL,
	`last_status` text,
	`last_error` text,
	`last_sent_at` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Retention pruning, export and forwarding all walk one org's rows by time.
CREATE INDEX `audit_log_org_created_idx` ON `audit_log` (`org_id`,`created_at`);
