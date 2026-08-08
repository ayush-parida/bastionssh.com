import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth.js';
import Layout from '@/components/layout/Layout.js';
import LoginPage from '@/pages/Login.js';
import DashboardPage from '@/pages/Dashboard.js';
import ServersPage from '@/pages/Servers.js';
import KeysPage from '@/pages/Keys.js';
import CommandsPage from '@/pages/Commands.js';
import CronJobsPage from '@/pages/CronJobs.js';
import AIChatPage from '@/pages/AIChat.js';
import AuditPage from '@/pages/Audit.js';
import SettingsPage from '@/pages/Settings.js';
import TerminalPage from '@/pages/Terminal.js';
import FilesPage from '@/pages/Files.js';
import MonitoringPage from '@/pages/Monitoring.js';
import ServerHealthPage from '@/pages/ServerHealth.js';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  return user ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<Navigate to="/login" replace />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="servers" element={<ServersPage />} />
          <Route path="servers/:id/terminal" element={<TerminalPage />} />
          <Route path="servers/:id/files" element={<FilesPage />} />
          <Route path="servers/:id/health" element={<ServerHealthPage />} />
          <Route path="monitoring" element={<MonitoringPage />} />
          <Route path="keys" element={<KeysPage />} />
          <Route path="commands" element={<CommandsPage />} />
          <Route path="cron-jobs" element={<CronJobsPage />} />
          <Route path="ai" element={<AIChatPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
