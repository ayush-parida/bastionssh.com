import { useQuery } from '@tanstack/react-query';
import type { AccessLevel, MyAccessLevels, ResourceType } from '@smt/shared';
import { api } from '@/lib/api.js';
import { levelAtLeast } from '@/lib/access.js';
import { useHasRole } from '@/store/auth.js';

/**
 * The signed-in member's level on each resource of a type (custom roles spec
 * §7), so pages hide buttons the level does not allow. UI-side only — the
 * server enforces every action regardless. Owners and admins manage
 * everything; until the levels load, nothing extra is hidden for them and
 * everything level-gated is hidden for everyone else.
 */
export function useAccessLevels(type: ResourceType) {
  const isAdmin = useHasRole('admin');
  const { data } = useQuery<MyAccessLevels>({
    queryKey: ['my-access', type],
    queryFn: () => api.get(`/team/access/mine?type=${type}`),
    enabled: !isAdmin,
    staleTime: 30_000,
  });
  const levelOf = (id: string | null | undefined): AccessLevel | null => {
    if (isAdmin || data?.orgAdmin) return 'manage';
    return id ? (data?.levels[id] ?? null) : null;
  };
  return {
    levelOf,
    /** True when the caller's level on `id` reaches `required`. */
    can: (id: string | null | undefined, required: AccessLevel) => levelAtLeast(levelOf(id), required),
    /** Clusters narrowed to some namespaces: which ones (undefined = every namespace). */
    namespacesOf: (id: string) => data?.namespaces?.[id],
  };
}
