import { eq } from 'drizzle-orm';
import { DEFAULT_DOCKER_SETTINGS, type DockerSettings } from '@smt/shared';
import { getDb } from '../db/index.js';
import { organizations } from '../db/schema.js';

/**
 * Org-wide Docker permissions, stored as JSON on the organization. A missing
 * or unreadable value, or a missing key, means the default for that key, so
 * settings added later start at their default for existing orgs.
 */

export function parseDockerSettings(raw: string | null | undefined): DockerSettings {
  let parsed: Partial<Record<keyof DockerSettings, unknown>> = {};
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value === 'object' && value !== null) parsed = value as typeof parsed;
    } catch {
      // unreadable: defaults
    }
  }
  const pick = (key: keyof DockerSettings) =>
    typeof parsed[key] === 'boolean' ? (parsed[key] as boolean) : DEFAULT_DOCKER_SETTINGS[key];
  return {
    operatorsCanExec: pick('operatorsCanExec'),
    operatorsCanRemove: pick('operatorsCanRemove'),
    allowPrune: pick('allowPrune'),
  };
}

export function dockerSettings(orgId: string): DockerSettings {
  const row = getDb()
    .select({ dockerSettings: organizations.dockerSettings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .get();
  return parseDockerSettings(row?.dockerSettings);
}

/** Merge `patch` into the org's settings and return the result. */
export function updateDockerSettings(orgId: string, patch: Partial<DockerSettings>): DockerSettings {
  const next = { ...dockerSettings(orgId), ...patch };
  getDb()
    .update(organizations)
    .set({ dockerSettings: JSON.stringify(next), updatedAt: new Date().toISOString() })
    .where(eq(organizations.id, orgId))
    .run();
  return next;
}
