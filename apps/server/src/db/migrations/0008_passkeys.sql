CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` blob NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text DEFAULT '[]' NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer DEFAULT 0 NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_id_unique` ON `passkeys` (`credential_id`);
--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`user_id`);
--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`purpose` text NOT NULL,
	`user_id` text,
	`session_hash` text,
	`ticket_hash` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_challenges_ticket_hash_unique` ON `webauthn_challenges` (`ticket_hash`);
--> statement-breakpoint
CREATE INDEX `webauthn_challenges_expires_idx` ON `webauthn_challenges` (`expires_at`);
--> statement-breakpoint
ALTER TABLE `organizations` ADD `require_passkey` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Existing sessions were password-only; orgs that later require passkeys send them to verify.
ALTER TABLE `sessions` ADD `passkey_verified` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Existing tokens were minted without a passkey; orgs that require passkeys refuse them.
ALTER TABLE `api_tokens` ADD `passkey_verified` integer DEFAULT 0 NOT NULL;
