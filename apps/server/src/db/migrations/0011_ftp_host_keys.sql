-- SFTP file connections pin the SSH host key like servers do. Existing rows
-- (FTP/FTPS, which have no host key) start with nothing pinned.
ALTER TABLE `ftp_connections` ADD `host_key_fingerprint` text;
--> statement-breakpoint
ALTER TABLE `ftp_connections` ADD `host_key_type` text;
--> statement-breakpoint
ALTER TABLE `ftp_connections` ADD `host_key_trusted_at` text;
--> statement-breakpoint
ALTER TABLE `ftp_connections` ADD `host_key_mismatch_fingerprint` text;
--> statement-breakpoint
ALTER TABLE `ftp_connections` ADD `host_key_mismatch_at` text;
