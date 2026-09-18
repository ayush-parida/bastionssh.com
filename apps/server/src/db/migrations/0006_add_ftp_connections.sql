CREATE TABLE `ftp_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 21 NOT NULL,
	`protocol` text DEFAULT 'ftps' NOT NULL,
	`username` text NOT NULL,
	`encrypted_password` text NOT NULL,
	`verify_tls` integer DEFAULT true NOT NULL,
	`root_path` text,
	`last_status` text,
	`last_error` text,
	`last_tested_at` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ftp_connections_org_idx` ON `ftp_connections` (`org_id`);
