import { useQuery } from '@tanstack/react-query';
import {
  MODULE_LEVELS,
  MODULES,
  type MeAccess,
  type MeModules,
  type ModuleKey,
  type ModuleLevel,
} from '@smt/shared';
import { api } from '@/lib/api.js';
import { useAuthStore } from '@/store/auth.js';

/**
 * What the signed-in member may use (unified roles spec §3, §5): the modules
 * shown to them and their level on each, from `GET /api/me/modules` and
 * `GET /api/me/access`. UI-side only — every route is enforced on the
 * server, which answers 404 for a module that is off or hidden and 403 for
 * one held at too low a level. Until the answers load, nothing is allowed
 * and nothing is shown.
 */

const LEVEL_ORDER = (level: ModuleLevel) => MODULE_LEVELS.indexOf(level);

/** `required` as `module` uses it: a level above its highest counts as its highest. */
function clamp(module: ModuleKey, required: ModuleLevel): ModuleLevel {
  const levels = MODULES.find((m) => m.key === module)?.levels ?? [];
  const top = levels[levels.length - 1] ?? 'none';
  return LEVEL_ORDER(required) > LEVEL_ORDER(top) ? top : required;
}

/** True when `held` on `module` reaches `required`. */
export function moduleAtLeast(module: ModuleKey, held: ModuleLevel | null | undefined, required: Exclude<ModuleLevel, 'none'>): boolean {
  return !!held && held !== 'none' && LEVEL_ORDER(held) >= LEVEL_ORDER(clamp(module, required));
}

/** The caller's roles, module levels and visible modules (`GET /api/me/access`). */
export function useMeAccess() {
  const signedIn = useAuthStore((s) => !!s.user);
  const recoveryGate = useAuthStore((s) => s.recoveryGate);
  return useQuery<MeAccess>({
    queryKey: ['me-access'],
    queryFn: () => api.get('/me/access'),
    // A backup-code session may only add a passkey: nothing else would answer
    enabled: signedIn && !recoveryGate,
    staleTime: 30_000,
  });
}

/** The modules to show, in navigation order (`GET /api/me/modules`). */
export function useVisibleModules() {
  const signedIn = useAuthStore((s) => !!s.user);
  const recoveryGate = useAuthStore((s) => s.recoveryGate);
  const { data, isLoading } = useQuery<MeModules>({
    queryKey: ['me-modules'],
    queryFn: () => api.get('/me/modules'),
    enabled: signedIn && !recoveryGate,
    staleTime: 30_000,
  });
  const visible = new Set((data?.modules ?? []).map((m) => m.module));
  return {
    loaded: !!data,
    isLoading,
    /** Shown in navigation: on, and for a resource module something in it (spec §3.1). */
    isVisible: (module: ModuleKey) => visible.has(module),
    /** Nothing at all is shown: the No-access home. */
    none: !!data && visible.size === 0,
    modules: data?.modules ?? [],
  };
}

/**
 * Whether the caller holds `module` at `level` or above (a level the module
 * does not use counts as its highest). Hide a button with it; the server
 * decides regardless.
 */
export function useModule(module: ModuleKey, level: Exclude<ModuleLevel, 'none'> = 'view'): boolean {
  const { data } = useMeAccess();
  return moduleAtLeast(module, data?.modules[module], level);
}

/** Holds the Owner role: transfer ownership, backups, SSO and the other owner-only actions (spec §4.3). */
export function useIsOwner(): boolean {
  const { data } = useMeAccess();
  return !!data?.owner;
}
