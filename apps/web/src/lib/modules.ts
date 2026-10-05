import type { ModuleKey } from '@smt/shared';

/**
 * Where each module lives in the app, for navigation and for sending a member
 * without the dashboard to the first module they have. Team & Access is three
 * modules on one page; Settings is everyone's (their own account) and
 * belongs to no module.
 */
export const MODULE_PATHS: Partial<Record<ModuleKey, string>> = {
  dashboard: '/',
  servers: '/servers',
  containers: '/containers',
  deployments: '/deployments',
  kubernetes: '/kubernetes',
  agents: '/agents',
  storage: '/storage',
  ftp: '/ftp',
  cloud: '/cloud',
  diagnostics: '/dns',
  monitoring: '/monitoring',
  ssh_keys: '/keys',
  saved_commands: '/commands',
  cron_jobs: '/cron-jobs',
  ai: '/ai',
  audit: '/audit',
  recordings: '/recordings',
  team_members: '/team',
  team_roles: '/team',
  team_sign_in: '/team',
};

/** The Team & Access page shows when any of its three modules does. */
export const TEAM_MODULES: ModuleKey[] = ['team_members', 'team_roles', 'team_sign_in'];
