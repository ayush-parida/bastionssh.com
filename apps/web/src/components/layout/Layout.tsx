import { useEffect } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrgSummary, Role, User } from '@smt/shared';
import { toast } from 'sonner';
import { useAuthStore } from '@/store/auth.js';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import {
  LayoutDashboard,
  Server,
  HardDrive,
  FolderSync,
  Cloud,
  Globe,
  Activity,
  Key,
  Terminal,
  Clock,
  Bot,
  ScrollText,
  Film,
  Settings,
  Users,
  Building2,
  LogOut,
  ChevronRight,
  Sun,
  Moon,
  RadioTower,
} from 'lucide-react';
import { useTheme } from '@/hooks/useTheme.js';

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/servers', label: 'Servers', icon: Server },
  { to: '/agents', label: 'Agents', icon: RadioTower },
  { to: '/storage', label: 'Object Storage', icon: HardDrive },
  { to: '/ftp', label: 'FTP', icon: FolderSync },
  { to: '/cloud', label: 'Cloud Accounts', icon: Cloud },
  { to: '/dns', label: 'DNS Lookup', icon: Globe },
  { to: '/monitoring', label: 'Monitoring', icon: Activity },
  { to: '/keys', label: 'SSH Keys', icon: Key },
  { to: '/commands', label: 'Saved Commands', icon: Terminal },
  { to: '/cron-jobs', label: 'Cron Jobs', icon: Clock },
  { to: '/ai', label: 'AI Assistant', icon: Bot },
  { to: '/audit', label: 'Audit Log', icon: ScrollText },
  { to: '/recordings', label: 'Recordings', icon: Film },
  { to: '/team', label: 'Team & Access', icon: Users },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Layout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user, orgId, clearUser, setUser } = useAuthStore();
  const { theme, toggle } = useTheme();
  const queryClient = useQueryClient();

  // Query keys are not scoped by user or org, so whatever ends the session —
  // sign-out or a 401 expiring it — must drop the cache before anyone else signs in.
  useEffect(
    () =>
      useAuthStore.subscribe((state, prev) => {
        if (prev.user && !state.user) queryClient.clear();
      }),
    [queryClient],
  );

  const { data: orgs } = useQuery<OrgSummary[]>({
    queryKey: ['auth-orgs'],
    queryFn: () => api.get('/auth/orgs'),
  });

  async function switchOrg(nextOrgId: string) {
    try {
      const res = await api.post<{ user: User; orgId: string; role: Role }>('/auth/switch-org', { orgId: nextOrgId });
      setUser({ ...(user as User), ...res.user }, res.orgId, res.role);
      // A backup-code session may have full access in the other org; the server re-raises it if not
      useAuthStore.getState().setRecoveryGate(false);
      // Query keys are not scoped by org — everything cached belongs to the old one
      await queryClient.resetQueries();
      navigate('/');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not switch organization');
    }
  }

  async function handleLogout() {
    await api.post('/auth/logout').catch(() => {});
    clearUser();
    queryClient.clear();
    navigate('/login');
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="w-60 flex flex-col border-r border-border bg-card">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <Server size={20} className="text-primary" />
          <span className="font-semibold text-sm">Server Manager</span>
        </div>

        {orgs && orgs.length > 1 && (
          <div className="border-b border-border p-2">
            <label className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5">
              <Building2 size={14} className="shrink-0 text-muted-foreground" />
              <select
                value={orgId ?? ''}
                onChange={(e) => switchOrg(e.target.value)}
                className="w-full min-w-0 bg-transparent text-sm focus:outline-none"
                title="Switch organization"
              >
                {orgs.map((o) => (
                  <option key={o.orgId} value={o.orgId} disabled={o.status === 'suspended'}>
                    {o.name}{o.status === 'suspended' ? ' (suspended)' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <nav className="flex-1 overflow-y-auto p-2">
          {navItems.map(({ to, label, icon: Icon }) => {
            const active = to === '/' ? pathname === '/' : pathname.startsWith(to);
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon size={16} />
                {label}
                {active && <ChevronRight size={14} className="ml-auto" />}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2 px-1 mb-2">
            <div className="size-7 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold text-primary">
              {user?.displayName?.[0]?.toUpperCase() ?? user?.email?.[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{user?.displayName ?? user?.email}</p>
              <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 mb-1">
            <button
              onClick={toggle}
              className="flex flex-1 items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
          </div>
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
