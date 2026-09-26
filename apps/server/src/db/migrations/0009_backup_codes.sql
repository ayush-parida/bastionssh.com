-- One-time recovery codes for accounts with passkeys. Only a keyed hash of each code is kept.
CREATE TABLE `backup_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_codes_code_hash_unique` ON `backup_codes` (`code_hash`);
--> statement-breakpoint
CREATE INDEX `backup_codes_user_idx` ON `backup_codes` (`user_id`);
--> statement-breakpoint
-- Wrong backup codes tried against a pending sign-in ticket; it is dropped after a few.
ALTER TABLE `webauthn_challenges` ADD `attempts` integer DEFAULT 0 NOT NULL;
