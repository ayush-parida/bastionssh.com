-- Per-org OpenID Connect single sign-on. One provider per org; the client secret is vault-encrypted.
CREATE TABLE `sso_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text DEFAULT 'generic' NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`encrypted_client_secret` text NOT NULL,
	`allowed_domains` text DEFAULT '[]' NOT NULL,
	`default_role` text DEFAULT 'viewer' NOT NULL,
	`auto_provision` integer DEFAULT 0 NOT NULL,
	`enforce_sso` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`trust_idp_mfa` integer DEFAULT 0 NOT NULL,
	`groups_claim` text,
	`role_mappings` text DEFAULT '[]' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sso_providers_org_id_unique` ON `sso_providers` (`org_id`);
--> statement-breakpoint
-- An account's identity at a provider: the IdP's stable `sub`, never the email, once linked.
CREATE TABLE `user_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`subject` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`created_at` text NOT NULL,
	`last_login_at` text,
	FOREIGN KEY (`provider_id`) REFERENCES `sso_providers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_provider_subject_unique` ON `user_identities` (`provider_id`,`subject`);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_provider_user_unique` ON `user_identities` (`provider_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `user_identities_user_idx` ON `user_identities` (`user_id`);
--> statement-breakpoint
-- Sign-ins sent to a provider and not yet back: short-lived, deleted on use. Only the state's hash is kept.
CREATE TABLE `sso_login_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`encrypted_code_verifier` text NOT NULL,
	`nonce` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `sso_providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sso_login_states_expires_idx` ON `sso_login_states` (`expires_at`);
--> statement-breakpoint
-- Sessions signed in through a provider. Removing the provider ends them; existing sessions were not SSO.
ALTER TABLE `sessions` ADD `sso_provider_id` text REFERENCES sso_providers(id) ON DELETE cascade;
