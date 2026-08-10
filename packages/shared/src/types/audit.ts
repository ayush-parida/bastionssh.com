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
  | 'sftp.list'
  | 'sftp.download'
  | 'sftp.upload'
  | 'sftp.mkdir'
  | 'sftp.rename'
  | 'sftp.delete'
  | 'ssh_key.create'
  | 'ssh_key.delete'
  | 'ssh_key.use'
  | 'command.run'
  | 'command.update'
  | 'cron_job.create'
  | 'cron_job.update'
  | 'cron_job.delete'
  | 'cron_job.run'
  | 'ai_provider.create'
  | 'ai_provider.delete'
  | 'org.update'
  | 'member.role_change'
  | 'member.remove'
  | 'api_token.create'
  | 'api_token.revoke'
  | 'server.health_check'
  | 'monitoring.update'
  | 'alert.acknowledge'
  | 'notification_channel.create'
  | 'notification_channel.update'
  | 'notification_channel.delete'
  | 'notification_channel.test';

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
