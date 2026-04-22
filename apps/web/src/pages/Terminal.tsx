import { useLocation, useParams, useNavigate } from 'react-router-dom';
import XTerminal from '@/components/terminal/XTerminal.js';
import { ArrowLeft } from 'lucide-react';
import { api } from '@/lib/api.js';

export default function TerminalPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const sessionId: string | undefined = location.state?.sessionId;

  async function handleClose() {
    if (sessionId) await api.delete(`/ssh-sessions/${sessionId}`).catch(() => {});
  }

  if (!sessionId) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">No active session. <a href="/servers" className="text-primary hover:underline">Go back to servers</a>.</p>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-[#0d1117]">
      <div className="flex items-center gap-3 px-4 h-10 bg-[#161b22] border-b border-[#30363d]">
        <button onClick={() => { handleClose(); navigate('/servers'); }} className="text-[#8b949e] hover:text-white">
          <ArrowLeft size={16} />
        </button>
        <span className="text-sm text-[#8b949e] font-mono">SSH Session — {id}</span>
      </div>
      <div className="flex-1 overflow-hidden">
        <XTerminal sessionId={sessionId} onClose={handleClose} />
      </div>
    </div>
  );
}
