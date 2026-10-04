import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { KubeExplainContext, KubeExplainEvent, KubeObjectRef } from '@smt/shared';
import { Loader2, Sparkles, X } from 'lucide-react';
import { api } from '@/lib/api.js';
import { readSSE } from '@/lib/sse.js';
import { kubePath } from '@/lib/kube.js';
import { useHasRole } from '@/store/auth.js';
import { useAccessLevels } from '@/hooks/useAccessLevels.js';

type State =
  | { phase: 'idle' }
  | { phase: 'running' | 'done'; context: KubeExplainContext | null; text: string }
  | { phase: 'error'; context: KubeExplainContext | null; text: string; error: string };

/** "Sent: the object (Secret values removed), 3 events, the last 42 log lines" — what left for the AI provider. */
function sentSummary(c: KubeExplainContext): string {
  const parts = [`the ${c.ref.kind} with Secret values removed`];
  if (c.pods) parts.push(`the status of ${c.pods} pod${c.pods === 1 ? '' : 's'} with problems`);
  parts.push(`${c.events} event${c.events === 1 ? '' : 's'}`);
  if (c.logLines) parts.push(`the last ${c.logLines} log line${c.logLines === 1 ? '' : 's'}`);
  return `Sent to ${c.provider}: ${parts.join(', ')}.`;
}

/**
 * AI "Explain this" for one object (spec §5.4, K5). Operators and up, like
 * the assistant. The server gathers the redacted object, its events, the
 * state of its troubled pods and a short log tail, and streams the
 * provider's plain-language explanation here; the dialog says what was
 * sent. The AI only explains — fixing stays with the guided buttons.
 */
export default function ExplainButton({
  clusterId,
  objectRef,
}: {
  clusterId: string;
  objectRef: Pick<KubeObjectRef, 'resource' | 'namespace' | 'name'>;
}) {
  // The base role, or `operate` on the cluster from a custom role (the server
  // checks the object's namespace too)
  const isOperator = useHasRole('operator');
  const canExplain = useAccessLevels('cluster').can(clusterId, 'operate') || isOperator;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ phase: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };
  const close = () => {
    stop();
    setOpen(false);
  };
  // Another object, or the panel closing, ends a running explanation
  useEffect(() => {
    setOpen(false);
    setState({ phase: 'idle' });
    return stop;
  }, [clusterId, objectRef.resource, objectRef.namespace, objectRef.name]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The object panel underneath closes on Escape too; this dialog goes first
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  });

  if (!canExplain) return null;

  const run = async () => {
    stop();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setOpen(true);
    let context: KubeExplainContext | null = null;
    let text = '';
    setState({ phase: 'running', context, text });
    try {
      const res = await api.stream(
        kubePath(clusterId, '/explain'),
        { resource: objectRef.resource, namespace: objectRef.namespace, name: objectRef.name },
        { signal: ctrl.signal },
      );
      for await (const event of readSSE<KubeExplainEvent>(res)) {
        if (event.type === 'context') context = event.context;
        else if (event.type === 'delta') text += event.content;
        else if (event.type === 'error') {
          setState({ phase: 'error', context, text, error: event.error });
          return;
        } else if (event.type === 'done') break;
        setState({ phase: 'running', context, text });
      }
      setState({ phase: 'done', context, text });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setState({ phase: 'error', context, text, error: err instanceof Error ? err.message : 'The explanation failed' });
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  };

  return (
    <>
      <button
        onClick={run}
        className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
        title="Ask the AI assistant to explain this object in plain language"
        data-testid="kube-explain"
      >
        <Sparkles size={13} className="text-primary" /> Explain
      </button>

      {open && state.phase !== 'idle' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={(e) => e.target === e.currentTarget && close()}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Explanation of ${objectRef.name}`}
            className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
          >
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <Sparkles size={16} className="shrink-0 text-primary" />
              <span className="flex-1 truncate text-sm font-semibold">Explain {objectRef.name}</span>
              {state.phase === 'running' && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
              <button onClick={close} className="text-muted-foreground hover:text-foreground" title="Close">
                <X size={14} />
              </button>
            </div>
            <div className="space-y-3 overflow-y-auto p-4" data-testid="kube-explanation">
              {state.context && <p className="text-xs text-muted-foreground">{sentSummary(state.context)}</p>}
              {state.text ? (
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.text}</ReactMarkdown>
                </div>
              ) : (
                state.phase === 'running' && (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 size={14} className="animate-spin" /> Looking at the object, its events and logs…
                  </p>
                )
              )}
              {state.phase === 'error' && (
                <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">
                  {state.error}
                  {/No AI provider/.test(state.error) && ' — an admin can add one under Settings → AI.'}
                </p>
              )}
              {state.phase === 'done' && (
                <p className="border-t border-border pt-3 text-xs text-muted-foreground">
                  AI can be wrong; check the events and logs it points to. It never changes the cluster.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
