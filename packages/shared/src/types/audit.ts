export type AuditAction =
  | 'user.login'
  | 'user.logout'
  | 'user.register'
  | 'user.password_change'
  | 'user.invite'
  | 'server.create'
  | 'server.update'
  | 'server.delete'
  | 'server.connect'
  | 'server.disconnect'
  | 'server.host_key_trusted'
  | 'server.host_key_mismatch'
  | 'server.host_key_pinned'
  | 'server.host_key_accepted'
  | 'server.host_key_forgotten'
  | 'server.host_key_cleared'
  | 'server.jump'
  | 'agent.create'
  | 'agent.revoke'
  | 'agent.connect'
  | 'agent.disconnect'
  | 'sftp.list'
  | 'sftp.download'
  | 'sftp.folder_download'
  | 'sftp.upload'
  | 'sftp.mkdir'
  | 'sftp.rename'
  | 'sftp.delete'
  | 'ssh_key.create'
  | 'ssh_key.delete'
  | 'ssh_key.use'
  | 'ssh_key.rotate'
  | 'ssh_key.rotate_failed'
  | 'ssh_key.rotate_bulk'
  | 'ssh_key.retire'
  | 'command.run'
  | 'command.update'
  | 'cron_job.create'
  | 'cron_job.update'
  | 'cron_job.delete'
  | 'cron_job.run'
  | 'ai_provider.create'
  | 'ai_provider.delete'
  | 'ai.command_run'
  | 'ai.command_approved'
  | 'ai.command_denied'
  | 'org.update'
  | 'member.role_change'
  | 'member.remove'
  | 'member.join'
  | 'member.suspend'
  | 'member.reactivate'
  | 'member.access_change'
  | 'member.access_expired'
  | 'member.scope_change'
  | 'member.grants_change'
  | 'member.roles_change'
  | 'role.create'
  | 'role.update'
  | 'role.delete'
  | 'role.grants_change'
  | 'role.member_add'
  | 'role.member_remove'
  | 'role.member_expired'
  | 'role.grant_expired'
  | 'role.reset'
  | 'org.default_role'
  | 'server.tags_change'
  | 'access_request.create'
  | 'access_request.cancel'
  | 'access_request.approve'
  | 'access_request.deny'
  | 'org.access_request_policy'
  | 'user.password_reset_issued'
  | 'user.password_reset_used'
  | 'user.sessions_revoked'
  | 'user.login_passkey'
  | 'user.passkey_added'
  | 'user.passkey_removed'
  | 'member.passkeys_reset'
  | 'user.backup_codes_generated'
  | 'user.login_backup_code'
  | 'org.passkey_policy'
  | 'org.sso_update'
  | 'org.sso_delete'
  | 'org.sso_test'
  | 'user.login_sso'
  | 'sso.login_failed'
  | 'sso.user_provisioned'
  | 'sso.identity_linked'
  | 'org.backup_code_policy'
  | 'api_token.create'
  | 'api_token.revoke'
  | 'server.health_check'
  | 'monitoring.update'
  | 'alert.acknowledge'
  | 'notification_channel.create'
  | 'notification_channel.update'
  | 'notification_channel.delete'
  | 'notification_channel.test'
  | 'storage_connection.create'
  | 'storage_connection.update'
  | 'storage_connection.delete'
  | 'storage_connection.test'
  | 'storage.bucket_create'
  | 'storage.bucket_delete'
  | 'storage.list'
  | 'storage.download'
  | 'storage.folder_download'
  | 'storage.upload'
  | 'storage.mkdir'
  | 'storage.rename'
  | 'storage.delete'
  | 'ftp_connection.create'
  | 'ftp_connection.update'
  | 'ftp_connection.delete'
  | 'ftp_connection.test'
  | 'ftp_connection.host_key_trusted'
  | 'ftp_connection.host_key_mismatch'
  | 'ftp_connection.host_key_pinned'
  | 'ftp_connection.host_key_accepted'
  | 'ftp_connection.host_key_forgotten'
  | 'ftp.list'
  | 'ftp.download'
  | 'ftp.folder_download'
  | 'ftp.upload'
  | 'ftp.mkdir'
  | 'ftp.rename'
  | 'ftp.delete'
  | 'ftp.path_refused'
  | 'cloud_account.create'
  | 'cloud_account.update'
  | 'cloud_account.delete'
  | 'cloud_account.test'
  | 'cloud_account.sync'
  | 'dns.lookup'
  | 'server.diagnose'
  | 'ftp_connection.diagnose'
  | 'storage_connection.diagnose'
  /** No longer written (listing backups is not audited); kept for older rows. */
  | 'backup.list'
  | 'backup.create'
  | 'backup.download'
  | 'backup.failed'
  | 'backup.upload_failed'
  | 'recording.view'
  | 'recording.download'
  | 'recording.delete'
  | 'recording.pruned'
  | 'org.recording_settings'
  | 'user.login_new_device'
  | 'user.login_failed'
  | 'user.login_locked'
  | 'audit.export'
  | 'audit.pruned'
  | 'audit.retention_update'
  | 'audit.forwarding_update'
  | 'audit.forwarding_delete'
  | 'audit.forwarding_test'
  | 'audit.forwarding_failed'
  | 'docker.probe'
  | 'docker.container_start'
  | 'docker.container_stop'
  | 'docker.container_restart'
  | 'docker.container_kill'
  | 'docker.container_pause'
  | 'docker.container_unpause'
  | 'docker.container_remove'
  | 'docker.image_pull'
  | 'docker.image_load'
  | 'docker.image_remove'
  | 'docker.prune'
  | 'docker.env_reveal'
  | 'docker.exec_start'
  | 'docker.exec_end'
  | 'docker.compose_up'
  | 'docker.compose_down'
  | 'docker.compose_pull'
  | 'docker.compose_restart'
  | 'docker.compose_stop'
  | 'deploy.setup'
  | 'deploy.bastionctl_upgrade'
  | 'deploy.proxy_upgrade'
  | 'deploy.start'
  | 'deploy.finish'
  | 'deploy.rollback'
  | 'deploy.restart'
  | 'deploy.stop'
  | 'deploy.delete'
  | 'deploy.config_update'
  | 'deploy.env_set'
  | 'deploy.env_unset'
  | 'deploy.env_generate'
  | 'deploy.env_reveal'
  | 'deploy.proxy_sync'
  | 'deploy.service_create'
  | 'deploy.service_update'
  | 'deploy.backup_create'
  | 'deploy.backup_download'
  | 'deploy.backup_restore'
  | 'deploy.backup_delete'
  | 'deploy.backup_schedule'
  | 'org.docker_settings'
  | 'ai.docker_read'
  | 'ai.kube_read'
  | 'kube.ai_explain'
  | 'kube_cluster.create'
  | 'kube_cluster.update'
  | 'kube_cluster.delete'
  | 'kube_cluster.test'
  | 'kube_cluster.diagnose'
  | 'kube_cluster.impersonation'
  | 'kube.secret_view'
  | 'kube.scale'
  | 'kube.restart'
  | 'kube.rollback'
  | 'kube.delete_pod'
  | 'kube.cordon'
  | 'kube.uncordon'
  | 'kube.cronjob_suspend'
  | 'kube.cronjob_resume'
  | 'kube.cronjob_trigger'
  | 'kube.exec_start'
  | 'kube.exec_end'
  | 'org.kube_settings';

export interface AuditLogEntry {
  id: string;
  orgId: string;
  actorId: string;
  actorEmail: string;
  action: AuditAction;
  resourceType: string;
  resourceId?: string;
  resourceName?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type AuditExportFormat = 'csv' | 'jsonl';

/** Filters shared by the audit list and export. Every field is optional. */
export interface AuditLogFilters {
  /** ISO timestamp or YYYY-MM-DD, inclusive. */
  from?: string;
  /** ISO timestamp or YYYY-MM-DD; a bare date includes that whole day. */
  to?: string;
  /** An exact action, or a prefix ending in `*` (e.g. `user.*`). */
  action?: string;
  actorEmail?: string;
  resourceType?: string;
  resourceId?: string;
}

export type SyslogProtocol = 'udp' | 'tcp' | 'tls';
export type AuditForwarderType = 'syslog' | 'webhook';

/** What the UI may see of the forwarding target. Webhook URLs and secrets are never returned. */
export interface AuditForwardingInfo {
  type: AuditForwarderType;
  enabled: boolean;
  /** tls://logs.example.com:6514, or the webhook URL with its path masked. */
  targetHint: string;
  syslog?: { host: string; port: number; protocol: SyslogProtocol; facility: number; hasCaCert: boolean };
  webhook?: { hasSecret: boolean };
  lastStatus: 'ok' | 'failed' | null;
  lastError: string | null;
  lastSentAt: string | null;
  updatedAt: string;
}

export interface AuditSettings {
  retentionDays: number;
  forwarding: AuditForwardingInfo | null;
}

export type AuditForwardingInput =
  | {
      type: 'syslog';
      host: string;
      port: number;
      protocol: SyslogProtocol;
      /** RFC 5424 facility code, 0–23. Defaults to 13 (log audit). */
      facility?: number;
      /** PEM bundle to trust for protocol "tls"; omitted keeps the current one, "" removes it. */
      caCert?: string;
      enabled?: boolean;
    }
  | {
      type: 'webhook';
      /** Required when creating or switching to a webhook; omitted keeps the current URL. */
      url?: string;
      /** HMAC-SHA256 signing secret; omitted keeps the current one, "" removes it. */
      secret?: string;
      enabled?: boolean;
    };
