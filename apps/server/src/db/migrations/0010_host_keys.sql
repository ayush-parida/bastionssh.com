-- Existing servers start with nothing pinned: their next connection trusts
-- whatever key the host presents (TOFU) and records it.
ALTER TABLE `servers` ADD `host_key_fingerprint` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `host_key_type` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `host_key_trusted_at` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `host_key_trusted_by` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `host_key_mismatch_fingerprint` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `host_key_mismatch_type` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `host_key_mismatch_at` text;
