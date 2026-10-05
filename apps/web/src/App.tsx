import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/store/auth.js';
import Layout from '@/components/layout/Layout.js';
import { HomeRoute, ModuleGate } from '@/components/layout/ModuleGate.js';
import { TEAM_MODULES } from '@/lib/modules.js';
import { ModuleNotFound } from '@/pages/NoAccess.js';
import LoginPage from '@/pages/Login.js';
import AcceptInvitePage from '@/pages/AcceptInvite.js';
import ResetPasswordPage from '@/pages/ResetPassword.js';
import TeamPage from '@/pages/Team.js';
import PasskeySetupPage from '@/pages/PasskeySetup.js';
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
import ServerDeploymentsPage from '@/pages/ServerDeployments.js';
import DeploymentsPage from '@/pages/Deployments.js';
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
          <Route index element={<HomeRoute />} />
          <Route path="servers" element={<ModuleGate modules={['servers']}><ServersPage /></ModuleGate>} />
          <Route path="servers/:id/terminal" element={<ModuleGate modules={['servers']}><TerminalPage /></ModuleGate>} />
          <Route path="servers/:id/files" element={<ModuleGate modules={['servers']}><FilesPage /></ModuleGate>} />
          <Route path="servers/:id/health" element={<ModuleGate modules={['servers']}><ServerHealthPage /></ModuleGate>} />
          <Route path="servers/:id/docker" element={<ModuleGate modules={['servers']}><ServerDockerPage /></ModuleGate>} />
          <Route path="servers/:id/deployments" element={<ModuleGate modules={['deployments']}><ServerDeploymentsPage /></ModuleGate>} />
          <Route path="servers/:id/deployments/:app" element={<ModuleGate modules={['deployments']}><ServerDeploymentsPage /></ModuleGate>} />
          <Route path="deployments" element={<ModuleGate modules={['deployments']}><DeploymentsPage /></ModuleGate>} />
          <Route path="containers" element={<ModuleGate modules={['containers']}><ContainersPage /></ModuleGate>} />
          <Route path="kubernetes" element={<ModuleGate modules={['kubernetes']}><KubernetesPage /></ModuleGate>} />
          <Route path="kubernetes/overview" element={<ModuleGate modules={['kubernetes']}><KubeOverviewPage /></ModuleGate>} />
          <Route path="kubernetes/:clusterId" element={<ModuleGate modules={['kubernetes']}><KubeClusterPage /></ModuleGate>} />
          <Route path="kubernetes/:clusterId/shell" element={<ModuleGate modules={['kubernetes']}><TerminalPage /></ModuleGate>} />
          <Route path="kubernetes/:clusterId/:tab" element={<ModuleGate modules={['kubernetes']}><KubeClusterPage /></ModuleGate>} />
          <Route path="kubernetes/:clusterId/objects/:resource/:ns/:name" element={<ModuleGate modules={['kubernetes']}><KubeClusterPage /></ModuleGate>} />
          <Route path="agents" element={<ModuleGate modules={['agents']}><AgentsPage /></ModuleGate>} />
          <Route path="storage" element={<ModuleGate modules={['storage']}><StoragePage /></ModuleGate>} />
          <Route path="storage/:id" element={<ModuleGate modules={['storage']}><StorageBucketsPage /></ModuleGate>} />
          <Route path="storage/:id/buckets/:bucket" element={<ModuleGate modules={['storage']}><StorageObjectsPage /></ModuleGate>} />
          <Route path="ftp" element={<ModuleGate modules={['ftp']}><FtpPage /></ModuleGate>} />
          <Route path="ftp/:id" element={<ModuleGate modules={['ftp']}><FtpFilesPage /></ModuleGate>} />
          <Route path="cloud" element={<ModuleGate modules={['cloud']}><CloudAccountsPage /></ModuleGate>} />
          <Route path="dns" element={<ModuleGate modules={['diagnostics']}><DnsLookupPage /></ModuleGate>} />
          <Route path="monitoring" element={<ModuleGate modules={['monitoring']}><MonitoringPage /></ModuleGate>} />
          <Route path="keys" element={<ModuleGate modules={['ssh_keys']}><KeysPage /></ModuleGate>} />
          <Route path="commands" element={<ModuleGate modules={['saved_commands']}><CommandsPage /></ModuleGate>} />
          <Route path="cron-jobs" element={<ModuleGate modules={['cron_jobs']}><CronJobsPage /></ModuleGate>} />
          <Route path="ai" element={<ModuleGate modules={['ai']}><AIChatPage /></ModuleGate>} />
          <Route path="audit" element={<ModuleGate modules={['audit']}><AuditPage /></ModuleGate>} />
          <Route path="recordings" element={<ModuleGate modules={['recordings']}><RecordingsPage /></ModuleGate>} />
          <Route path="recordings/:id" element={<ModuleGate modules={['recordings']}><RecordingPlayerPage /></ModuleGate>} />
          <Route path="team" element={<ModuleGate modules={TEAM_MODULES}><TeamPage /></ModuleGate>} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<ModuleNotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
