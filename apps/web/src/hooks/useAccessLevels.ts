import { useQuery } from '@tanstack/react-query';
import type { AccessLevel, MyAccessLevels, ResourceType } from '@smt/shared';
import { api } from '@/lib/api.js';
import { levelAtLeast } from '@/lib/access.js';
import { useIsOwner } from '@/hooks/useModules.js';

/**
 * The signed-in member's level on each resource of a type (custom roles spec
 * §7), so pages hide buttons the level does not allow. UI-side only — the
 * server enforces every action regardless. Owners manage everything (the
 * Owner role is locked); everyone else's levels come from their roles, so
 * until they load, everything level-gated is hidden.
 */
export function useAccessLevels(type: ResourceType) {
  const isOwner = useIsOwner();
  const { data } = useQuery<MyAccessLevels>({
    queryKey: ['my-access', type],
    queryFn: () => api.get(`/team/access/mine?type=${type}`),
    enabled: !isOwner,
    staleTime: 30_000,
  });
  const levelOf = (id: string | null | undefined): AccessLevel | null => {
    if (isOwner || data?.orgAdmin) return 'manage';
    return id ? (data?.levels[id] ?? null) : null;
  };
  return {
    levelOf,
    /** True when the caller's level on `id` reaches `required`. */
    can: (id: string | null | undefined, required: AccessLevel) => levelAtLeast(levelOf(id), required),
    /** True when the caller's base role allows `action` on any `id` they see, whatever its level. */
    baseAllows: (id: string | null | undefined, action: string) =>
      levelOf(id) !== null && (data?.baseActions ?? []).includes(action),
    /** Clusters narrowed to some namespaces: which ones (undefined = every namespace). */
    namespacesOf: (id: string) => data?.namespaces?.[id],
  };
}
