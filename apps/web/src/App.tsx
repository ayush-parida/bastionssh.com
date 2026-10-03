import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/store/auth.js';
import Layout from '@/components/layout/Layout.js';
import LoginPage from '@/pages/Login.js';
import AcceptInvitePage from '@/pages/AcceptInvite.js';
import ResetPasswordPage from '@/pages/ResetPassword.js';
import TeamPage from '@/pages/Team.js';
import PasskeySetupPage from '@/pages/PasskeySetup.js';
import DashboardPage from '@/pages/Dashboard.js';
import ServersPage from '@/pages/Servers.js';
import KeysPage from '@/pages/Keys.js';
import CommandsPage from '@/pages/Commands.js';
import CronJobsPage from '@/pages/CronJobs.js';
import AIChatPage from '@/pages/AIChat.js';
import AuditPage from '@/pages/Audit.js';
import RecordingsPage from '@/pages/Recordings.js';
import RecordingPlayerPage from '@/pages/RecordingPlayer.js';
import SettingsPage from '@/pages/Settings.js';
import TerminalPage from '@/pages/Terminal.js';
import FilesPage from '@/pages/Files.js';
import MonitoringPage from '@/pages/Monitoring.js';
import ServerHealthPage from '@/pages/ServerHealth.js';
import ServerDockerPage from '@/pages/ServerDocker.js';
import ContainersPage from '@/pages/Containers.js';
import StoragePage from '@/pages/Storage.js';
import StorageBucketsPage from '@/pages/StorageBuckets.js';
import StorageObjectsPage from '@/pages/StorageObjects.js';
import FtpPage from '@/pages/Ftp.js';
import FtpFilesPage from '@/pages/FtpFiles.js';
import CloudAccountsPage from '@/pages/CloudAccounts.js';
import DnsLookupPage from '@/pages/DnsLookup.js';
import AgentsPage from '@/pages/Agents.js';
import KubernetesPage from '@/pages/Kubernetes.js';
import KubeClusterPage from '@/pages/KubeCluster.js';
import KubeOverviewPage from '@/pages/KubeOverview.js';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  // The org requires a passkey this session has not used: nothing else works until it has
  const passkeyGate = useAuthStore((s) => s.passkeyGate);
  // Signed in with a backup code: only adding a passkey works until it is verified
  const recoveryGate = useAuthStore((s) => s.recoveryGate);
  const { pathname } = useLocation();
  if (!user) return <Navigate to="/login" replace />;
  if (passkeyGate) return <Navigate to="/passkey-setup" replace />;
  if (recoveryGate && pathname !== '/settings') {
    return <Navigate to="/settings" replace state={{ backupCodeSignIn: true }} />;
  }
  return <>{children}</>;
}

function RequireSignedIn({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  return user ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite/:token" element={<AcceptInvitePage />} />
        <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
        <Route path="/register" element={<Navigate to="/login" replace />} />
        <Route
          path="/passkey-setup"
          element={
            <RequireSignedIn>
              <PasskeySetupPage />
            </RequireSignedIn>
          }
        />
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
          <Route path="servers/:id/docker" element={<ServerDockerPage />} />
          <Route path="containers" element={<ContainersPage />} />
          <Route path="kubernetes" element={<KubernetesPage />} />
          <Route path="kubernetes/overview" element={<KubeOverviewPage />} />
          <Route path="kubernetes/:clusterId" element={<KubeClusterPage />} />
          <Route path="kubernetes/:clusterId/shell" element={<TerminalPage />} />
          <Route path="kubernetes/:clusterId/:tab" element={<KubeClusterPage />} />
          <Route path="kubernetes/:clusterId/objects/:resource/:ns/:name" element={<KubeClusterPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="storage" element={<StoragePage />} />
          <Route path="storage/:id" element={<StorageBucketsPage />} />
          <Route path="storage/:id/buckets/:bucket" element={<StorageObjectsPage />} />
          <Route path="ftp" element={<FtpPage />} />
          <Route path="ftp/:id" element={<FtpFilesPage />} />
          <Route path="cloud" element={<CloudAccountsPage />} />
          <Route path="dns" element={<DnsLookupPage />} />
          <Route path="monitoring" element={<MonitoringPage />} />
          <Route path="keys" element={<KeysPage />} />
          <Route path="commands" element={<CommandsPage />} />
          <Route path="cron-jobs" element={<CronJobsPage />} />
          <Route path="ai" element={<AIChatPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="recordings" element={<RecordingsPage />} />
          <Route path="recordings/:id" element={<RecordingPlayerPage />} />
          <Route path="team" element={<TeamPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
