import type { DeployPermissionLevel } from './deploy.js';

/**
 * Who may deploy an app (deployments spec §2.7): `bastion.yml` may raise the
 * level deploy and rollback need on the server with `permissions.deploy`.
 * Read from what `bastionctl status` reports on each request, like the rest
 * of an app's settings — nothing about it is stored in BastionSSH.
 */

function deployField(holder: unknown): unknown {
  if (typeof holder !== 'object' || holder === null) return undefined;
  const permissions = (holder as { permissions?: unknown }).permissions;
  return typeof permissions === 'object' && permissions !== null ? (permissions as { deploy?: unknown }).deploy : undefined;
}

/**
 * The level `permissions.deploy` sets, from `bastionctl status` (top-level
 * `permissions`, or inside `config`). A missing field means `operate`. A
 * value this version does not know, or an app whose bastion.yml could not be
 * read, means `manage` — the stricter side, since a deploy runs the app's
 * code with its secrets.
 */
export function deployPermissionLevel(
  status: { config?: unknown; configError?: string | null; permissions?: unknown } | null | undefined,
): DeployPermissionLevel {
  const value = deployField(status) ?? deployField(status?.config);
  if (value === undefined || value === null) return status?.configError && !status.config ? 'manage' : 'operate';
  return value === 'operate' || value === 'view' ? 'operate' : 'manage';
}
