-- Kubernetes clusters, reached over HTTPS: directly, through a managed
-- server's SSH connection (forwardOut), or through a connectivity agent.
-- connect_via: direct | server | agent. auth_type: token | cert. The
-- credential (token, or client cert + key as JSON) is vault-encrypted and
-- never returned; credential_hint is what the UI shows instead.
CREATE TABLE `kube_clusters` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`api_url` text NOT NULL,
	`connect_via` text DEFAULT 'direct' NOT NULL,
	`via_server_id` text,
	`via_agent_id` text,
	`ca_data` text,
	`auth_type` text NOT NULL,
	`encrypted_credential` text NOT NULL,
	`credential_hint` text NOT NULL,
	`impersonate` integer DEFAULT 0 NOT NULL,
	`default_namespace` text DEFAULT 'default' NOT NULL,
	`namespaces_allowlist` text,
	`last_status` text,
	`last_error` text,
	`last_checked_at` text,
	`server_version` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`via_server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`via_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `kube_clusters_org_idx` ON `kube_clusters` (`org_id`);
--> statement-breakpoint
CREATE INDEX `kube_clusters_via_server_idx` ON `kube_clusters` (`via_server_id`);
--> statement-breakpoint
-- Clusters a `restricted` member may use, like member_server_access: null
-- expires_at = permanent; past = no longer counts, swept by the expiry job.
CREATE TABLE `member_cluster_access` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`cluster_id` text NOT NULL,
	`expires_at` text,
	`granted_by` text,
	`reason` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cluster_id`) REFERENCES `kube_clusters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_cluster_access_idx` ON `member_cluster_access` (`org_id`,`user_id`,`cluster_id`);
--> statement-breakpoint
CREATE INDEX `member_cluster_access_cluster_idx` ON `member_cluster_access` (`cluster_id`);
--> statement-breakpoint
CREATE INDEX `member_cluster_access_expires_idx` ON `member_cluster_access` (`expires_at`);
--> statement-breakpoint
-- JSON {operatorsCanExec, operatorsCanDeletePods, operatorsCanScale, showConfigMapValues, clusterAlerts}; null = defaults.
ALTER TABLE `organizations` ADD `kube_settings` text;
