import { eq } from 'drizzle-orm';
import { DEFAULT_KUBE_SETTINGS, type KubeSettings } from '@smt/shared';
import { getDb } from '../db/index.js';
import { organizations } from '../db/schema.js';

/**
 * Org-wide Kubernetes permissions, stored as JSON on the organization like
 * Docker's (docker/settings.ts). A missing or unreadable value, or a missing
 * key, means the default for that key (spec §13), so settings added later
 * start at their default for existing orgs.
 */

const KEYS = Object.keys(DEFAULT_KUBE_SETTINGS) as (keyof KubeSettings)[];

export function parseKubeSettings(raw: string | null | undefined): KubeSettings {
  let parsed: Partial<Record<keyof KubeSettings, unknown>> = {};
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value === 'object' && value !== null) parsed = value as typeof parsed;
    } catch {
      // unreadable: defaults
    }
  }
  return Object.fromEntries(
    KEYS.map((key) => [key, typeof parsed[key] === 'boolean' ? (parsed[key] as boolean) : DEFAULT_KUBE_SETTINGS[key]]),
  ) as unknown as KubeSettings;
}

export function kubeSettings(orgId: string): KubeSettings {
  const row = getDb()
    .select({ kubeSettings: organizations.kubeSettings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .get();
  return parseKubeSettings(row?.kubeSettings);
}

/** Merge `patch` into the org's settings and return the result. */
export function updateKubeSettings(orgId: string, patch: Partial<KubeSettings>): KubeSettings {
  const next = { ...kubeSettings(orgId), ...patch };
  getDb()
    .update(organizations)
    .set({ kubeSettings: JSON.stringify(next), updatedAt: new Date().toISOString() })
    .where(eq(organizations.id, orgId))
    .run();
  return next;
}
