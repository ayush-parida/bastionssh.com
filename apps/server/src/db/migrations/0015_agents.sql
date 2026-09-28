-- Outbound connectivity agents. Existing servers keep connecting directly
-- (agent_id null).
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`last_seen_at` text,
	`version` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_token_hash_unique` ON `agents` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `agents_org_idx` ON `agents` (`org_id`);
--> statement-breakpoint
ALTER TABLE `servers` ADD `agent_id` text REFERENCES agents(id) ON DELETE set null;
