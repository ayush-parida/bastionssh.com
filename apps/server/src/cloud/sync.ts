import type { CloudInstance, CloudInstanceState, CloudProvider, SyncSummary } from '@smt/shared';
import { pickHost } from './types.js';

/** The slice of a `servers` row the planner needs. */
export interface ExistingCloudServer {
  id: string;
  cloudInstanceId: string;
  host: string;
  cloudState: string | null;
}

export interface PlannedUpdate {
  serverId: string;
  /** null = keep the current host (the instance has no usable IP right now). */
  host: string | null;
  region: string;
  state: CloudInstanceState;
}

export interface SyncPlan {
  create: CloudInstance[];
  update: PlannedUpdate[];
  /** Server ids no longer returned by the provider (and not already flagged). */
  markMissing: string[];
  /** Unknown instances that cannot be imported because they have no IP. */
  skipped: CloudInstance[];
}

/**
 * Decide what a sync should do. Pure: rows in, plan out, no DB.
 *
 * Existing servers are matched on the provider's instance id. Matches get
 * host/region/state refreshed and nothing else — name, tags, credentials and
 * notes belong to the user after import. Unknown instances are created only
 * when the account auto-imports, and only if they have an address to SSH to.
 */
export function planSync(
  existing: ExistingCloudServer[],
  discovered: CloudInstance[],
  autoImport: boolean,
): SyncPlan {
  const byInstance = new Map(existing.map((s) => [s.cloudInstanceId, s]));
  const seen = new Set<string>();
  const plan: SyncPlan = { create: [], update: [], markMissing: [], skipped: [] };

  for (const instance of discovered) {
    seen.add(instance.id);
    const current = byInstance.get(instance.id);
    if (current) {
      plan.update.push({
        serverId: current.id,
        host: pickHost(instance),
        region: instance.region,
        state: instance.state,
      });
    } else if (autoImport) {
      if (pickHost(instance)) plan.create.push(instance);
      else plan.skipped.push(instance);
    }
  }

  for (const server of existing) {
    if (!seen.has(server.cloudInstanceId) && server.cloudState !== 'missing') {
      plan.markMissing.push(server.id);
    }
  }

  return plan;
}

/** Tags an imported server starts with: provider, region, then the provider's own. */
export function importTags(provider: CloudProvider, instance: CloudInstance): string[] {
  return [...new Set([`cloud:${provider}`, instance.region, ...instance.tags])];
}

export function summarize(plan: SyncPlan, discovered: number): SyncSummary {
  return {
    discovered,
    created: plan.create.length,
    updated: plan.update.length,
    missing: plan.markMissing.length,
    skipped: plan.skipped.length,
  };
}
