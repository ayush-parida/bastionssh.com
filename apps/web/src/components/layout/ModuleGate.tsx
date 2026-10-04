import { Navigate } from 'react-router-dom';
import type { ModuleKey } from '@smt/shared';
import { useVisibleModules } from '@/hooks/useModules.js';
import { useAssistantAccess } from '@/hooks/useAssistantAccess.js';
import { MODULE_PATHS } from '@/lib/modules.js';
import { ModuleNotFound, NoAccessHome } from '@/pages/NoAccess.js';
import DashboardPage from '@/pages/Dashboard.js';

/**
 * Pages of a module render only for members it is shown to (unified roles
 * spec §3.1, §5): a deep link into a module that is off or empty for them
 * gets the not-found page, as the server answers 404 there.
 */
export function ModuleGate({ modules, children }: { modules: ModuleKey[]; children: React.ReactNode }) {
  const { loaded, isVisible } = useVisibleModules();
  const assistant = useAssistantAccess();
  if (!loaded) return null;
  // The assistant also opens to whoever may operate something (custom roles spec §5)
  const shown = modules.some(isVisible) || (modules.includes('ai') && assistant);
  return shown ? <>{children}</> : <ModuleNotFound />;
}

/**
 * Home: the dashboard when it is shown; otherwise the first module that is;
 * with nothing shown at all, the No-access home.
 */
export function HomeRoute() {
  const { loaded, none, isVisible, modules } = useVisibleModules();
  if (!loaded) return null;
  if (none) return <NoAccessHome />;
  if (isVisible('dashboard')) return <DashboardPage />;
  const first = modules.map((m) => MODULE_PATHS[m.module]).find(Boolean);
  return first ? <Navigate to={first} replace /> : <NoAccessHome />;
}
