import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ActiveRecording, KubePodShellTarget, Server } from '@smt/shared';
import { kubeObjectUrl } from '@smt/shared';
import XTerminal, {
  type TerminalConnectionStatus,
  type XTerminalHandle,
} from '@/components/terminal/XTerminal.js';
import AISidebar from '@/components/ai/AISidebar.js';
import { ArrowLeft, Boxes, Bot, Container, FolderOpen, Keyboard, Unplug } from 'lucide-react';
import { api } from '@/lib/api.js';
import { HostKeyMismatchNotice } from '@/components/servers/HostKey.js';
import { DiagnoseButton } from '@/components/diagnostics/Diagnostics.js';

/** Rolling buffer size for terminal output captured for AI context (bytes) */
const OUTPUT_BUFFER_SIZE = 8_000;

const STATUS_LABEL: Record<TerminalConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
};

const STATUS_DOT: Record<TerminalConnectionStatus, string> = {
  connecting: 'bg-[#d29922] animate-pulse',
  connected: 'bg-[#3fb950]',
  disconnected: 'bg-[#6e7681]',
};

export default function TerminalPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const sessionId: string | undefined = location.state?.sessionId;
  const stateServerName: string | undefined = location.state?.serverName;
  /** Set when the org records this session; says whether keystrokes are captured too. */
  const recording: ActiveRecording | null | undefined = location.state?.recording;
  /** Set for a shell inside a Docker container (kind `container`) rather than on the server itself. */
  const container: { id: string; name: string } | undefined = location.state?.container;
  /** Set for a shell in a Kubernetes pod's container (kind `pod`); there is no server then. */
  const pod: KubePodShellTarget | undefined = location.state?.pod;
  // A container shell comes from, and returns to, the server's Docker page; a pod shell to the pod's panel
  const backTo = pod
    ? kubeObjectUrl(pod.clusterId, { resource: 'pods', namespace: pod.namespace, name: pod.name })
    : container
      ? `/servers/${id}/docker`
      : '/servers';
  const backLabel = pod ? 'Back to the pod' : container ? 'Back to Docker' : 'Back to servers';
  /** Files and the AI assistant work on a server itself, not inside a container or pod. */
  const onServer = !container && !pod;

  const [aiOpen, setAiOpen] = useState(false);
  const [status, setStatus] = useState<TerminalConnectionStatus>('connecting');
  const [disconnecting, setDisconnecting] = useState(false);
  const [hostKeyMismatch, setHostKeyMismatch] = useState(false);
  const terminalRef = useRef<XTerminalHandle>(null);
  const terminalOutputRef = useRef<string>('');
  /** Set once the server-side session has been torn down, so we only DELETE it once */
  const sessionClosedRef = useRef(false);

  // Same query key as the Files page so the two share a cache entry
  const { data: server } = useQuery<Server>({
    queryKey: ['servers', id],
    queryFn: () => api.get(`/servers/${id}`),
    enabled: !!id && !pod,
  });

  // Say so up front: keystroke recording captures passwords typed at hidden prompts too
  useEffect(() => {
    if (recording?.inputRecorded) {
      toast.warning('Keystrokes in this session are recorded, including any passwords you type.', {
        id: `recording-input-${sessionId}`,
      });
    }
  }, [recording?.inputRecorded, sessionId]);

  const serverName = server?.name ?? stateServerName ?? pod?.clusterName ?? id;
  const endpoint = server ? `${server.username}@${server.host}:${server.port}` : undefined;

  const handleOutput = useCallback((data: string) => {
    terminalOutputRef.current = (terminalOutputRef.current + data).slice(-OUTPUT_BUFFER_SIZE);
  }, []);

  /**
   * Tear down the SSH session on the server. Deduped so an explicit Disconnect and
   * the WebSocket's own close event don't both fire a DELETE. Resolves to whether
   * the session is now closed.
   */
  const closeSession = useCallback(async (): Promise<boolean> => {
    if (!sessionId || sessionClosedRef.current) return true;
    sessionClosedRef.current = true;
    try {
      await api.delete(`/ssh-sessions/${sessionId}`);
      return true;
    } catch {
      sessionClosedRef.current = false;
      return false;
    }
  }, [sessionId]);

  const handleWsClose = useCallback(() => {
    void closeSession();
  }, [closeSession]);

  async function handleDisconnect() {
    setDisconnecting(true);
    const closed = await closeSession();
    if (closed) {
      // The broker closes the WebSocket too, but flip the UI now so it never lags.
      setStatus('disconnected');
    } else {
      toast.error('Failed to disconnect');
    }
    setDisconnecting(false);
  }

  function handleBack() {
    void closeSession();
    navigate(backTo);
  }

  if (!sessionId) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">
          No active session.{' '}
          <a href="/servers" className="text-primary hover:underline">
            Go back to servers
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-[#0d1117]">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 h-10 bg-[#161b22] border-b border-[#30363d] shrink-0">
        <button
          onClick={handleBack}
          title={backLabel}
          className="text-[#8b949e] hover:text-white transition-colors"
        >
          <ArrowLeft size={16} />
        </button>

        {/* Server identity + connection state */}
        <div className="flex min-w-0 flex-1 items-center gap-3 font-mono text-sm">
          {pod ? (
            <span
              className="flex min-w-0 items-center gap-1.5 text-[#8b949e]"
              title={`${pod.container} in pod ${pod.namespace}/${pod.name} on cluster ${pod.clusterName}`}
              data-testid="pod-shell-target"
            >
              <Boxes size={14} className="shrink-0 text-[#58a6ff]" aria-hidden="true" />
              <span className="truncate font-medium text-[#e6edf3]">{pod.container}</span>
              <span className="font-sans">in</span>
              <span className="truncate text-[#e6edf3]">
                {pod.namespace}/{pod.name}
              </span>
              <span className="font-sans">on</span>
              <span className="truncate text-[#e6edf3]">{pod.clusterName}</span>
            </span>
          ) : container ? (
            <span
              className="flex min-w-0 items-center gap-1.5 text-[#8b949e]"
              title={`${container.name} (${container.id.slice(0, 12)}) on ${serverName}`}
            >
              <Container size={14} className="shrink-0 text-[#58a6ff]" aria-hidden="true" />
              <span className="font-sans">container</span>
              <span className="truncate font-medium text-[#e6edf3]">{container.name}</span>
              <span className="font-sans">on</span>
              <span className="truncate text-[#e6edf3]">{serverName}</span>
            </span>
          ) : (
            <span className="truncate font-medium text-[#e6edf3]" title={serverName}>
              {serverName}
            </span>
          )}
          {endpoint && onServer && (
            <span className="hidden truncate text-[#8b949e] sm:inline" title={endpoint}>
              {endpoint}
            </span>
          )}
          <span
            className="flex shrink-0 items-center gap-1.5 text-xs text-[#8b949e]"
            role="status"
            aria-live="polite"
          >
            <span className={`size-2 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
            {STATUS_LABEL[status]}
          </span>
        </div>

        {recording && (
          <span
            className={`flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-xs ${
              recording.inputRecorded ? 'bg-[#d29922]/15 text-[#e3b341]' : 'text-[#8b949e]'
            }`}
            title={
              recording.inputRecorded
                ? 'This session is recorded, including everything you type — passwords entered at sudo or login prompts too.'
                : 'This session\'s output is recorded for playback. Keystrokes are not recorded.'
            }
          >
            <span className="size-2 rounded-full bg-[#f85149]" aria-hidden="true" />
            REC
            {recording.inputRecorded && (
              <>
                <Keyboard size={12} aria-hidden="true" />
                <span className="hidden md:inline">Keystrokes recorded</span>
              </>
            )}
          </span>
        )}

        {/* Files and the AI assistant work on the server itself, not inside a container */}
        {onServer && (
          <>
            <button
              onClick={() => navigate(`/servers/${id}/files`)}
              title="Browse files over SFTP"
              className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-[#8b949e] transition-colors hover:bg-[#21262d] hover:text-white"
            >
              <FolderOpen size={13} />
              Files
            </button>
            <button
              onClick={() => setAiOpen((o) => !o)}
              title="Toggle AI Assistant"
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors ${
                aiOpen
                  ? 'bg-[#58a6ff]/20 text-[#58a6ff]'
                  : 'text-[#8b949e] hover:text-white hover:bg-[#21262d]'
              }`}
            >
              <Bot size={13} />
              AI
            </button>
          </>
        )}
        {status === 'disconnected' && pod && (
          // The route to the cluster's API server, step by step
          <DiagnoseButton
            target={{ kind: 'kube_cluster', id: pod.clusterId, name: pod.clusterName }}
            className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-[#8b949e] transition-colors hover:bg-[#21262d] hover:text-white"
          />
        )}
        {status === 'disconnected' && id && !pod && !hostKeyMismatch && (
          // A session that failed to open, or dropped: say why, step by step
          <DiagnoseButton
            target={{ kind: 'server', id, name: serverName ?? id }}
            className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-[#8b949e] transition-colors hover:bg-[#21262d] hover:text-white"
          />
        )}
        {status === 'disconnected' ? (
          <button
            onClick={() => navigate(backTo)}
            className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-[#8b949e] transition-colors hover:bg-[#21262d] hover:text-white"
          >
            <ArrowLeft size={13} />
            {backLabel}
          </button>
        ) : (
          <button
            onClick={() => void handleDisconnect()}
            disabled={disconnecting}
            title={pod ? 'Close the shell in the pod' : container ? 'Close the shell in the container' : 'Close the SSH session'}
            className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-[#f85149] transition-colors hover:bg-[#f85149]/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Unplug size={13} />
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </button>
        )}
      </div>

      {/* Main area: terminal + optional sidebar */}
      <div className="flex flex-1 overflow-hidden">
        <div className={`relative ${aiOpen ? 'w-[58%] shrink-0' : 'flex-1'}`}>
          <XTerminal
            ref={terminalRef}
            sessionId={sessionId}
            onClose={handleWsClose}
            onOutput={handleOutput}
            onStatusChange={setStatus}
            onHostKeyMismatch={() => setHostKeyMismatch(true)}
          />
          {hostKeyMismatch && id && !pod && (
            <HostKeyMismatchNotice
              serverId={id}
              expected={server?.hostKeyFingerprint ?? undefined}
              className="absolute inset-x-4 bottom-4 bg-card"
            />
          )}
        </div>

        {aiOpen && onServer && (
          <div className="flex-1 overflow-hidden">
            <AISidebar
              serverId={id}
              serverName={serverName}
              sessionId={sessionId}
              terminalOutput={terminalOutputRef.current}
              onInjectInput={(data) => terminalRef.current?.sendInput(data)}
              onClose={() => setAiOpen(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
