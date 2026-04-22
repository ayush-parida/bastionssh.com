import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import type { AIProviderConfig, AIAgentEvent } from '@smt/shared';
import { Send, Bot, User, Terminal, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ToolCallRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  expanded: boolean;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallRecord[];
}

export default function AIChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [providerId, setProviderId] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: providers } = useQuery<AIProviderConfig[]>({
    queryKey: ['ai-providers'],
    queryFn: () => api.get('/ai/providers'),
  });

  useEffect(() => {
    if (providers && Array.isArray(providers) && providers.length > 0 && !providerId) setProviderId((providers as AIProviderConfig[])[0]!.id);
  }, [providers, providerId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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

  async function handleSend() {
    if (!input.trim() || streaming || !providerId) return;
    const userMsg = input.trim();
    setInput('');

    const assistantMsg: Message = { role: 'assistant', content: '', toolCalls: [] };
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }, assistantMsg]);
    setStreaming(true);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          providerId,
          agentMode: true,
          messages: [...messages, { role: 'user', content: userMsg }],
        }),
      });

      if (!res.ok) throw new Error(await res.text());
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
              return [...prev.slice(0, -1), { ...last, toolCalls: [...(last.toolCalls ?? []), tc] }];
            });
          } else if (event.type === 'tool_result') {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last || last.role !== 'assistant') return prev;
              const toolCalls = (last.toolCalls ?? []).map((tc) =>
                tc.id === event.id ? { ...tc, output: event.output, isError: event.isError } : tc,
              );
              return [...prev.slice(0, -1), { ...last, toolCalls }];
            });
          } else if (event.type === 'done' || event.type === 'error') {
            if (event.type === 'error') {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (!last) return prev;
                return [...prev.slice(0, -1), { ...last, content: last.content + `\n\n**Error:** ${event.error}` }];
              });
            }
            break;
          }
        }
      }
    } catch (err: unknown) {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (!last) return prev;
        return [...prev.slice(0, -1), { ...last, content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }];
      });
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 h-14 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Bot size={18} className="text-primary" />
          <h1 className="font-semibold">AI Assistant</h1>
        </div>
        {providers && providers.length > 0 && (
          <select
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Bot size={48} className="mb-3 opacity-20" />
            <p>Ask anything about your servers, commands, or infrastructure.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'assistant' && (
              <div className="size-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-0.5">
                <Bot size={14} className="text-primary" />
              </div>
            )}
            <div className={`max-w-[80%] space-y-2 ${m.role === 'user' ? 'items-end flex flex-col' : ''}`}>
              {/* Tool calls */}
              {m.toolCalls?.map((tc) => (
                <div
                  key={tc.id}
                  className="w-full rounded-lg border border-border bg-muted/40 text-xs overflow-hidden"
                >
                  <button
                    onClick={() => toggleToolCall(i, tc.id)}
                    className="flex items-center gap-1.5 w-full px-3 py-2 text-left text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {tc.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <Terminal size={12} className="text-primary" />
                    <span className="font-mono text-primary">{tc.name}</span>
                    {tc.output === undefined && (
                      <Loader2 size={11} className="ml-auto animate-spin text-primary" />
                    )}
                    {tc.isError && <span className="ml-auto text-destructive text-[10px]">error</span>}
                  </button>
                  {tc.expanded && (
                    <div className="px-3 pb-2 space-y-1.5 border-t border-border">
                      <div className="mt-1.5">
                        <p className="text-[10px] text-muted-foreground mb-0.5">Input</p>
                        <pre className="text-[10px] whitespace-pre-wrap bg-background/60 rounded p-1.5 overflow-x-auto font-mono">{JSON.stringify(tc.input, null, 2)}</pre>
                      </div>
                      {tc.output !== undefined && (
                        <div>
                          <p className="text-[10px] text-muted-foreground mb-0.5">Output</p>
                          <pre className={`text-[10px] whitespace-pre-wrap bg-background/60 rounded p-1.5 overflow-x-auto font-mono ${tc.isError ? 'text-destructive' : 'text-green-400'}`}>
                            {tc.output.slice(0, 2000)}{tc.output.length > 2000 && '\n…(truncated)'}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {/* Message text */}
              {(m.content || (streaming && i === messages.length - 1 && m.role === 'assistant')) && (
                <div className={`rounded-lg px-4 py-2.5 text-sm ${m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                  {m.role === 'user' ? (
                    <span className="whitespace-pre-wrap">{m.content}</span>
                  ) : m.content ? (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                        h1: ({ children }) => <h1 className="text-lg font-bold mb-2 mt-3 first:mt-0">{children}</h1>,
                        h2: ({ children }) => <h2 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h2>,
                        h3: ({ children }) => <h3 className="text-sm font-bold mb-1 mt-2 first:mt-0">{children}</h3>,
                        ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
                        ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
                        li: ({ children }) => <li className="ml-2">{children}</li>,
                        code: ({ inline, children }: { inline?: boolean; children?: React.ReactNode }) =>
                          inline ? (
                            <code className="bg-background/60 rounded px-1 py-0.5 font-mono text-xs">{children}</code>
                          ) : (
                            <code className="block bg-background/60 rounded p-3 font-mono text-xs overflow-x-auto mb-2 whitespace-pre">{children}</code>
                          ),
                        pre: ({ children }) => <>{children}</>,
                        blockquote: ({ children }) => <blockquote className="border-l-2 border-primary/40 pl-3 italic text-muted-foreground mb-2">{children}</blockquote>,
                        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="underline hover:opacity-80">{children}</a>,
                        table: ({ children }) => <div className="overflow-x-auto mb-2"><table className="w-full text-xs border-collapse">{children}</table></div>,
                        th: ({ children }) => <th className="border border-border/50 px-2 py-1 bg-background/40 font-semibold text-left">{children}</th>,
                        td: ({ children }) => <td className="border border-border/50 px-2 py-1">{children}</td>,
                        hr: () => <hr className="border-border/50 my-2" />,
                        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                      }}
                    >
                      {m.content}
                    </ReactMarkdown>
                  ) : (
                    <span className="animate-pulse">▌</span>
                  )}
                </div>
              )}
            </div>
            {m.role === 'user' && (
              <div className="size-7 rounded-full bg-secondary flex items-center justify-center shrink-0 mt-0.5">
                <User size={14} />
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-6 pb-6">
        <div className="flex gap-2 rounded-lg border border-input bg-background px-3 py-2 focus-within:ring-2 focus-within:ring-primary">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="Ask a question… (Enter to send, Shift+Enter for newline)"
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm focus:outline-none"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || streaming || !providerId}
            className="self-end rounded-md bg-primary p-1.5 text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
