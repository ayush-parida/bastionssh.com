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
  /**
   * The current org requires a passkey sign-in this session has not done.
   * `RequireAuth` holds the app at /passkey-setup until it is cleared.
   */
  passkeyGate: boolean;
  /**
   * The org started enforcing single sign-on and this session did not use it.
   * The login screen says so and offers SSO for this org slug.
   */
  ssoRequired: { orgSlug: string; message: string } | null;
  setUser: (user: User, orgId: string | null, role: Role) => void;
  clearUser: () => void;
  expireSession: () => void;
  setPasskeyGate: (on: boolean) => void;
  requireSso: (orgSlug: string, message: string) => void;
}

const signedOut = { user: null, orgId: null, role: null } as const;

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      ...signedOut,
      sessionExpired: false,
      passkeyGate: false,
      ssoRequired: null,
      setUser: (user, orgId, role) => set({ user, orgId, role, sessionExpired: false, ssoRequired: null }),
      clearUser: () => set({ ...signedOut, sessionExpired: false, passkeyGate: false, ssoRequired: null }),
      /**
       * Sign out because the server no longer accepts the session. Idempotent, so
       * a burst of concurrent 401s only raises the notice once.
       */
      expireSession: () =>
        set((state) => (state.user ? { ...signedOut, sessionExpired: true, passkeyGate: false } : state)),
      setPasskeyGate: (on) => set((state) => (state.passkeyGate === on ? state : { passkeyGate: on })),
      /** Like expireSession, but the way back in is this org's SSO. */
      requireSso: (orgSlug, message) =>
        set((state) =>
          state.user ? { ...signedOut, sessionExpired: false, passkeyGate: false, ssoRequired: { orgSlug, message } } : state,
        ),
    }),
    {
      name: 'smt-auth',
      // `sessionExpired`, `passkeyGate` and `ssoRequired` describe this page load only — never
      // restore them. The server re-raises the gate on the next request.
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
