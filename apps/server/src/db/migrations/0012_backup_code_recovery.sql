-- A backup-code sign-in may, per org, only enroll a new passkey until it
-- steps up with one. On by default, existing orgs included. Existing sessions
-- cannot be told apart from ordinary ones, so they keep the access they had.
ALTER TABLE `organizations` ADD `backup_code_recovery_only` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `recovery_only` integer DEFAULT 0 NOT NULL;
