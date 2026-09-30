-- Docker management. Detection is on demand only, so existing servers are
-- untouched until someone opens their Docker tab: mode 'auto', nothing
-- detected, default socket.
-- docker_mode: auto | off. 'off' hides the tab and refuses the Docker routes.
ALTER TABLE `servers` ADD `docker_mode` text DEFAULT 'auto' NOT NULL;
--> statement-breakpoint
-- Admin override (rootless Docker, Podman); null = detect.
ALTER TABLE `servers` ADD `docker_socket_path` text;
--> statement-breakpoint
-- Last successful probe: streamlocal | dial-stdio, the socket it reached,
-- when, and the engine and negotiated API versions.
ALTER TABLE `servers` ADD `docker_transport` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `docker_detected_socket_path` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `docker_detected_at` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `docker_version` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `docker_api_version` text;
--> statement-breakpoint
-- JSON {operatorsCanExec, operatorsCanRemove, allowPrune}; null = defaults.
ALTER TABLE `organizations` ADD `docker_settings` text;
