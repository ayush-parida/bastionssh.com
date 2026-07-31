import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Role, User } from '@smt/shared';

/** Least- to most-privileged; mirrors ROLES on the server. */
const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

interface AuthState {
  user: User | null;
  orgId: string | null;
  role: Role | null;
  setUser: (user: User, orgId: string, role: Role) => void;
  clearUser: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      orgId: null,
      role: null,
      setUser: (user, orgId, role) => set({ user, orgId, role }),
      clearUser: () => set({ user: null, orgId: null, role: null }),
    }),
    { name: 'smt-auth' },
  ),
);

/**
 * Whether the current user meets a minimum role. UI-side only — every
 * privileged route is independently enforced on the server.
 */
export function useHasRole(minimum: Role): boolean {
  const role = useAuthStore((s) => s.role);
  return role != null && ROLE_RANK[role] >= ROLE_RANK[minimum];
}
