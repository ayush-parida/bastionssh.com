import { useCallback, useRef, useState } from 'react';
import { useLocation, useParams, useNavigate } from 'react-router-dom';
import XTerminal, { type XTerminalHandle } from '@/components/terminal/XTerminal.js';
import AISidebar from '@/components/ai/AISidebar.js';
import { ArrowLeft, Bot } from 'lucide-react';
import { api } from '@/lib/api.js';

/** Rolling buffer size for terminal output captured for AI context (bytes) */
const OUTPUT_BUFFER_SIZE = 8_000;

export default function TerminalPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const sessionId: string | undefined = location.state?.sessionId;
  const serverName: string | undefined = location.state?.serverName;

  const [aiOpen, setAiOpen] = useState(false);
  const terminalRef = useRef<XTerminalHandle>(null);
  const terminalOutputRef = useRef<string>('');

  const handleOutput = useCallback((data: string) => {
    terminalOutputRef.current = (terminalOutputRef.current + data).slice(-OUTPUT_BUFFER_SIZE);
  }, []);

  async function handleClose() {
    if (sessionId) await api.delete(`/ssh-sessions/${sessionId}`).catch(() => {});
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
          onClick={() => {
            void handleClose();
            navigate('/servers');
          }}
          className="text-[#8b949e] hover:text-white transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <span className="text-sm text-[#8b949e] font-mono flex-1">
          SSH Session — {serverName ?? id}
        </span>
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
      </div>

      {/* Main area: terminal + optional sidebar */}
      <div className="flex flex-1 overflow-hidden">
        <div className={aiOpen ? 'w-[58%] shrink-0' : 'flex-1'}>
          <XTerminal
            ref={terminalRef}
            sessionId={sessionId}
            onClose={handleClose}
            onOutput={handleOutput}
          />
        </div>

        {aiOpen && (
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
