import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Role, User } from '@smt/shared';

/** Least- to most-privileged; mirrors ROLES on the server. */
const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

interface AuthState {
  user: User | null;
  orgId: string | null;
  role: Role | null;
  /** True when the server rejected the session, so the login screen can say why. */
  sessionExpired: boolean;
  setUser: (user: User, orgId: string, role: Role) => void;
  clearUser: () => void;
  expireSession: () => void;
}

const signedOut = { user: null, orgId: null, role: null } as const;

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      ...signedOut,
      sessionExpired: false,
      setUser: (user, orgId, role) => set({ user, orgId, role, sessionExpired: false }),
      clearUser: () => set({ ...signedOut, sessionExpired: false }),
      /**
       * Sign out because the server no longer accepts the session. Idempotent, so
       * a burst of concurrent 401s only raises the notice once.
       */
      expireSession: () =>
        set((state) => (state.user ? { ...signedOut, sessionExpired: true } : state)),
    }),
    {
      name: 'smt-auth',
      // `sessionExpired` describes this page load only — never restore it.
      partialize: ({ user, orgId, role }) => ({ user, orgId, role }),
    },
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
