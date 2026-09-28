-- Per-connection options for FTP/SFTP file connections.
-- restrict_to_root confines every path to the start directory (or the login
-- directory). Existing rows keep today's behaviour (off); the API turns it on
-- for new connections.
ALTER TABLE `ftp_connections` ADD `restrict_to_root` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- password | key. Key auth (SFTP only) logs in with an org SSH key instead of
-- the stored password.
ALTER TABLE `ftp_connections` ADD `auth_method` text DEFAULT 'password' NOT NULL;
--> statement-breakpoint
ALTER TABLE `ftp_connections` ADD `ssh_key_id` text REFERENCES `ssh_keys`(`id`);
