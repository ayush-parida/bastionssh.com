-- A server may be reached through another managed server in the same org (ssh -J).
-- Existing servers keep connecting directly. Deleting a jump host leaves the
-- servers behind it in place and makes them direct again.
ALTER TABLE `servers` ADD `jump_server_id` text REFERENCES servers(id) ON DELETE set null;
--> statement-breakpoint
CREATE INDEX `servers_jump_server_idx` ON `servers` (`jump_server_id`);
