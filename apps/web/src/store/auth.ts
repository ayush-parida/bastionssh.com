import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '@smt/shared';

interface AuthState {
  user: User | null;
  orgId: string | null;
  setUser: (user: User, orgId: string) => void;
  clearUser: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      orgId: null,
      setUser: (user, orgId) => set({ user, orgId }),
      clearUser: () => set({ user: null, orgId: null }),
    }),
    { name: 'smt-auth' },
  ),
);
