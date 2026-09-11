CREATE TABLE `storage_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text DEFAULT 's3' NOT NULL,
	`endpoint` text,
	`region` text DEFAULT 'us-east-1' NOT NULL,
	`access_key_id` text NOT NULL,
	`encrypted_secret_access_key` text NOT NULL,
	`force_path_style` integer DEFAULT false NOT NULL,
	`last_status` text,
	`last_error` text,
	`last_tested_at` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `storage_connections_org_idx` ON `storage_connections` (`org_id`);
