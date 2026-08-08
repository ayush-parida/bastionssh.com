import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import type { AIProviderConfig, AIAgentEvent } from '@smt/shared';
import {
  Bot,
  User,
  Send,
  ChevronDown,
  ChevronRight,
  Terminal,
  Loader2,
  Zap,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallRecord[];
}

interface ToolCallRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  expanded: boolean;
}

interface AISidebarProps {
  serverId?: string;
  serverName?: string;
  sessionId?: string;
  /** Ring-buffer of recent terminal output (plain text, ANSI stripped) */
  terminalOutput: string;
  /** Send raw bytes to the terminal stdin */
  onInjectInput?: (data: string) => void;
  onClose?: () => void;
}

const QUICK_ACTIONS = [
  { label: 'CPU & memory', prompt: 'Show current CPU usage and memory utilization.' },
  { label: 'Disk usage', prompt: 'Show disk space usage across all mounted filesystems.' },
  { label: 'Running services', prompt: 'List all running systemd services and their status.' },
  { label: 'Active connections', prompt: 'Show active network connections and listening ports.' },
  { label: 'Recent errors', prompt: 'Check for recent errors in system logs (last 50 lines of /var/log/syslog or journalctl).' },
  { label: 'Top processes', prompt: 'Show the top 10 processes by CPU and memory consumption.' },
];

/** Strip ANSI escape codes from terminal output for clean AI context */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[mGKHFABCDJnsuhl]/g, '').replace(/\x1b\]/g, '');
}

/** Extract shell code blocks from markdown and return unique commands */
function extractShellCommands(text: string): string[] {
  const matches = text.matchAll(/```(?:sh|bash|shell|zsh)?\n([\s\S]+?)```/g);
  const cmds: string[] = [];
  for (const m of matches) {
    const cmd = m[1]?.trim();
    if (cmd && !cmds.includes(cmd)) cmds.push(cmd);
  }
  return cmds;
}

export default function AISidebar({
  serverId,
  serverName,
  sessionId,
  terminalOutput,
  onInjectInput,
  onClose,
}: AISidebarProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [providerId, setProviderId] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { data: providers } = useQuery<AIProviderConfig[]>({
    queryKey: ['ai-providers'],
    queryFn: () => api.get('/ai/providers'),
  });

  useEffect(() => {
    if (providers && Array.isArray(providers) && providers.length > 0 && !providerId) {
      setProviderId((providers as AIProviderConfig[])[0]!.id);
    }
  }, [providers, providerId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(
    async (userText: string) => {
      if (!userText.trim() || streaming || !providerId) return;

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const userMsg: Message = { role: 'user', content: userText.trim() };
      const assistantMsg: Message = { role: 'assistant', content: '', toolCalls: [] };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setStreaming(true);

      try {
        const res = await api.stream(
          '/ai/chat',
          {
            providerId,
            sessionId,
            agentMode: true,
            context: {
              serverId,
              lastOutput: stripAnsi(terminalOutput).slice(-4000),
            },
            messages: [
              ...messages.map((m) => ({ role: m.role, content: m.content })),
              { role: 'user', content: userText.trim() },
            ],
          },
          { signal: ctrl.signal },
        );

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6);
            let event: AIAgentEvent;
            try {
              event = JSON.parse(raw) as AIAgentEvent;
            } catch {
              continue;
            }

            if (event.type === 'delta') {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (!last || last.role !== 'assistant') return prev;
                return [...prev.slice(0, -1), { ...last, content: last.content + event.content }];
              });
            } else if (event.type === 'tool_call') {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (!last || last.role !== 'assistant') return prev;
                const tc: ToolCallRecord = {
                  id: event.id,
                  name: event.name,
                  input: event.input ?? {},
                  expanded: true,
                };
                return [
                  ...prev.slice(0, -1),
                  { ...last, toolCalls: [...(last.toolCalls ?? []), tc] },
                ];
              });
            } else if (event.type === 'tool_result') {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (!last || last.role !== 'assistant') return prev;
                const toolCalls = (last.toolCalls ?? []).map((tc) =>
                  tc.id === event.id
                    ? { ...tc, output: event.output, isError: event.isError }
                    : tc,
                );
                return [...prev.slice(0, -1), { ...last, toolCalls }];
              });
            } else if (event.type === 'done' || event.type === 'error') {
              if (event.type === 'error') {
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (!last) return prev;
                  return [
                    ...prev.slice(0, -1),
                    { ...last, content: last.content + `\n\n**Error:** ${event.error}` },
                  ];
                });
              }
              break;
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last) return prev;
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              content:
                last.content || `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
            },
          ];
        });
      } finally {
        setStreaming(false);
      }
    },
    [messages, providerId, serverId, sessionId, streaming, terminalOutput],
  );

  function handleSend() {
    if (!input.trim()) return;
    setInput('');
    void sendMessage(input);
  }

  function toggleToolCall(msgIdx: number, tcId: string) {
    setMessages((prev) =>
      prev.map((m, i) =>
        i !== msgIdx
          ? m
          : {
              ...m,
              toolCalls: (m.toolCalls ?? []).map((tc) =>
                tc.id === tcId ? { ...tc, expanded: !tc.expanded } : tc,
              ),
            },
      ),
    );
  }

  const noProvider = !providers || providers.length === 0;

  return (
    <div className="flex flex-col h-full border-l border-[#30363d] bg-[#0d1117] text-[#c9d1d9]">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-10 bg-[#161b22] border-b border-[#30363d] shrink-0">
        <Bot size={15} className="text-[#58a6ff]" />
        <span className="text-sm font-medium flex-1">
          AI Assistant{serverName ? ` — ${serverName}` : ''}
        </span>
        {providers && providers.length > 1 && (
          <select
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            className="text-xs bg-[#21262d] border border-[#30363d] rounded px-1.5 py-0.5 text-[#8b949e] focus:outline-none"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {onClose && (
          <button
            onClick={onClose}
            className="text-[#8b949e] hover:text-white transition-colors"
            title="Close AI panel"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {noProvider && (
        <div className="flex-1 flex items-center justify-center p-4 text-center text-xs text-[#8b949e]">
          No AI provider configured.
          <br />
          Add one in <strong>Settings → AI</strong>.
        </div>
      )}

      {!noProvider && (
        <>
          {/* Quick action chips */}
          {messages.length === 0 && (
            <div className="px-3 pt-3 shrink-0">
              <p className="text-[10px] text-[#8b949e] mb-2 flex items-center gap-1">
                <Zap size={10} /> Quick actions
              </p>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_ACTIONS.map((a) => (
                  <button
                    key={a.label}
                    onClick={() => void sendMessage(a.prompt)}
                    disabled={streaming}
                    className="rounded-full border border-[#30363d] bg-[#161b22] px-2 py-0.5 text-[10px] text-[#8b949e] hover:border-[#58a6ff] hover:text-[#58a6ff] transition-colors disabled:opacity-40"
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Message list */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 text-sm">
            {messages.map((m, msgIdx) => (
              <div key={msgIdx} className="flex gap-2">
                <div className="shrink-0 mt-0.5">
                  {m.role === 'assistant' ? (
                    <div className="size-5 rounded-full bg-[#58a6ff]/20 flex items-center justify-center">
                      <Bot size={11} className="text-[#58a6ff]" />
                    </div>
                  ) : (
                    <div className="size-5 rounded-full bg-[#21262d] flex items-center justify-center">
                      <User size={11} className="text-[#8b949e]" />
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0 space-y-1.5">
                  {/* Tool calls */}
                  {m.toolCalls?.map((tc) => (
                    <div
                      key={tc.id}
                      className="rounded border border-[#30363d] bg-[#161b22] text-xs overflow-hidden"
                    >
                      <button
                        onClick={() => toggleToolCall(msgIdx, tc.id)}
                        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
                      >
                        {tc.expanded ? (
                          <ChevronDown size={11} />
                        ) : (
                          <ChevronRight size={11} />
                        )}
                        <Terminal size={11} className="text-[#58a6ff]" />
                        <span className="font-mono text-[#58a6ff]">{tc.name}</span>
                        {tc.output === undefined && (
                          <Loader2 size={10} className="ml-auto animate-spin text-[#58a6ff]" />
                        )}
                        {tc.isError && (
                          <span className="ml-auto text-[#ff7b72] text-[10px]">error</span>
                        )}
                      </button>

                      {tc.expanded && (
                        <div className="px-2.5 pb-2 space-y-1.5 border-t border-[#30363d]">
                          {/* Input */}
                          <div className="mt-1.5">
                            <p className="text-[10px] text-[#8b949e] mb-0.5">Input</p>
                            <pre className="text-[10px] text-[#c9d1d9] whitespace-pre-wrap bg-[#0d1117] rounded p-1.5 overflow-x-auto font-mono">
                              {JSON.stringify(tc.input, null, 2)}
                            </pre>
                          </div>
                          {/* Output */}
                          {tc.output !== undefined && (
                            <div>
                              <p className="text-[10px] text-[#8b949e] mb-0.5">Output</p>
                              <pre
                                className={`text-[10px] whitespace-pre-wrap bg-[#0d1117] rounded p-1.5 overflow-x-auto font-mono ${tc.isError ? 'text-[#ff7b72]' : 'text-[#3fb950]'}`}
                              >
                                {tc.output.slice(0, 2000)}
                                {tc.output.length > 2000 ? '\n…(truncated)' : null}
                              </pre>
                              {/* Run-in-terminal button for run_command results */}
                              {tc.name === 'run_command' && !!tc.input.command && onInjectInput && (
                                <button
                                  onClick={() =>
                                    onInjectInput(
                                      String(tc.input.command) + '\n',
                                    )
                                  }
                                  className="mt-1 flex items-center gap-1 text-[10px] text-[#8b949e] hover:text-[#58a6ff] transition-colors"
                                >
                                  <Terminal size={10} /> Re-run in terminal
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Message text */}
                  {m.content && (
                    <AssistantText
                      content={m.content}
                      isUser={m.role === 'user'}
                      onRunCommand={onInjectInput}
                      isStreaming={
                        streaming && msgIdx === messages.length - 1 && m.role === 'assistant'
                      }
                    />
                  )}
                  {!m.content &&
                    streaming &&
                    msgIdx === messages.length - 1 &&
                    m.role === 'assistant' &&
                    (!m.toolCalls || m.toolCalls.length === 0) && (
                      <span className="text-xs text-[#58a6ff] animate-pulse">▌</span>
                    )}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="shrink-0 px-3 pb-3 pt-1">
            <div className="flex gap-1.5 rounded-lg border border-[#30363d] bg-[#161b22] px-2.5 py-2 focus-within:border-[#58a6ff]/50">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Ask anything… (Enter to send)"
                rows={1}
                className="flex-1 resize-none bg-transparent text-sm text-[#c9d1d9] placeholder:text-[#8b949e] focus:outline-none"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || streaming || !providerId}
                className="self-end rounded p-1 bg-[#58a6ff] text-[#0d1117] hover:bg-[#79c0ff] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Send size={12} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── AssistantText ─────────────────────────────────────────────────────────────

function AssistantText({
  content,
  isUser,
  onRunCommand,
  isStreaming,
}: {
  content: string;
  isUser: boolean;
  onRunCommand?: (cmd: string) => void;
  isStreaming?: boolean;
}) {
  if (isUser) {
    return (
      <p className="text-sm text-[#c9d1d9] whitespace-pre-wrap">{content}</p>
    );
  }

  const commands = extractShellCommands(content);

  return (
    <div className="text-sm text-[#c9d1d9] space-y-1">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
          h1: ({ children }) => (
            <h1 className="text-base font-bold mb-1.5 mt-2 first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-sm font-bold mb-1 mt-2 first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-xs font-bold mb-0.5 mt-1.5 first:mt-0">{children}</h3>
          ),
          ul: ({ children }) => (
            <ul className="list-disc list-inside mb-1.5 space-y-0.5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside mb-1.5 space-y-0.5">{children}</ol>
          ),
          li: ({ children }) => <li className="ml-1.5">{children}</li>,
          code: ({ inline, children }: { inline?: boolean; children?: React.ReactNode }) =>
            inline ? (
              <code className="bg-[#161b22] rounded px-1 py-0.5 font-mono text-[11px] text-[#79c0ff]">
                {children}
              </code>
            ) : (
              <code className="block bg-[#161b22] rounded p-2 font-mono text-[11px] text-[#c9d1d9] overflow-x-auto mb-1.5 whitespace-pre">
                {children}
              </code>
            ),
          pre: ({ children }) => <>{children}</>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[#58a6ff]/40 pl-2.5 italic text-[#8b949e] mb-1.5">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#58a6ff] underline hover:opacity-80"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-[#e6edf3]">{children}</strong>
          ),
        }}
      >
        {content}
      </ReactMarkdown>

      {isStreaming && <span className="text-[#58a6ff] animate-pulse">▌</span>}

      {/* "Run in terminal" buttons for extracted commands */}
      {!isStreaming && commands.length > 0 && onRunCommand && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {commands.map((cmd) => (
            <button
              key={cmd}
              onClick={() => onRunCommand(cmd + '\n')}
              title={cmd}
              className="flex items-center gap-1 rounded border border-[#30363d] bg-[#161b22] px-2 py-0.5 text-[10px] text-[#8b949e] hover:border-[#58a6ff] hover:text-[#58a6ff] transition-colors font-mono"
            >
              <Terminal size={9} />
              <span className="max-w-[140px] truncate">{cmd.split('\n')[0]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
