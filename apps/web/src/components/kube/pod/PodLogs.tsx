import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { KubeContainerView, KubeLogLine } from '@smt/shared';
import { Download, History, Pause, Play, Search, WrapText } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils.js';
import { downloadPodLogs, followPodLogs, usePodDetail } from '@/lib/kube-pods.js';
import { containerStatus } from './ContainerLanes.js';

/** Lines kept in the browser; older ones scroll away (the download has the whole tail). */
const MAX_LINES = 5_000;
const TAILS = [100, 500, 2_000, 10_000];

/** `text` with every case-insensitive match of `q` marked. */
function highlight(text: string, q: string) {
  if (!q) return text;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(q, from); at !== -1; at = lower.indexOf(q, from)) {
    parts.push(text.slice(from, at), <mark key={at} className="rounded-sm bg-amber-300 text-zinc-950">{text.slice(at, at + q.length)}</mark>);
    from = at + q.length;
  }
  parts.push(text.slice(from));
  return parts.map((p, i) => <Fragment key={i}>{p}</Fragment>);
}

/**
 * A pod's logs (operators and up): one container at a time — picked from the
 * pod's containers, each shown with its state — current run or, after a
 * crash, the previous one. Followed live over server-sent events; search
 * filters and marks matches; the download streams the same tail as text.
 */
export default function PodLogs({
  clusterId,
  namespace,
  name,
  initialContainer,
  initialPrevious = false,
}: {
  clusterId: string;
  namespace: string;
  name: string;
  initialContainer?: string;
  initialPrevious?: boolean;
}) {
  const pod = usePodDetail(clusterId, namespace, name);
  const containers: KubeContainerView[] = pod.data?.containers ?? [];
  const [container, setContainer] = useState(initialContainer ?? '');
  const [previous, setPrevious] = useState(initialPrevious);
  const [follow, setFollow] = useState(!initialPrevious);
  const [timestamps, setTimestamps] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [tail, setTail] = useState(500);
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState<KubeLogLine[]>([]);
  const [state, setState] = useState<'loading' | 'live' | 'ended' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Until one is picked, the pod's default container (the server picks the same one)
  const picked = container || pod.data?.defaultContainer || '';
  const current = containers.find((c) => c.name === picked);
  const hasPrevious = !!current && (current.lastTermination !== null || current.restarts > 0);
  // A previous run's log is finished: there is nothing to follow
  const following = follow && !previous;

  useEffect(() => {
    if (pod.isLoading) return;
    const abort = new AbortController();
    setLines([]);
    setError(null);
    setTruncated(false);
    setState('loading');
    stick.current = true;
    followPodLogs(clusterId, namespace, name, { container: picked || undefined, previous, follow: following, tail, timestamps }, abort.signal, (event) => {
      if (event.type === 'ready') {
        setState('live');
        if (!container) setContainer(event.container);
      } else if (event.type === 'logs') {
        setState('live');
        setLines((prev) => {
          const next = prev.concat(event.lines);
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      } else if (event.type === 'end') {
        if (event.truncated) setTruncated(true);
        setState('ended');
      } else if (event.type === 'error') {
        setError(event.error);
        setState('error');
      }
    })
      .then(() => setState((s) => (s === 'error' ? s : 'ended')))
      .catch((err: Error) => {
        if (abort.signal.aborted) return;
        setError(err.message);
        setState('error');
      });
    return () => abort.abort();
    // `container` is only filled in from `ready`; `picked` is what is read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, namespace, name, picked, previous, following, tail, timestamps, pod.isLoading]);

  const q = search.trim().toLowerCase();
  const shown = useMemo(() => (q ? lines.filter((l) => l.text.toLowerCase().includes(q)) : lines), [lines, q]);

  // Keep the view at the bottom while following, unless the user scrolled up
  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown]);

  async function download() {
    try {
      await downloadPodLogs(clusterId, namespace, name, { container: picked || undefined, previous, tail: Math.max(tail, 10_000), timestamps });
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="pod-logs">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <select
          value={picked}
          onChange={(e) => {
            setContainer(e.target.value);
            setPrevious(false);
            setFollow(true);
          }}
          title="Container"
          aria-label="Container"
          data-testid="log-container"
          className="max-w-[14rem] rounded-md border border-input bg-background px-1.5 py-1 text-xs"
        >
          {!picked && <option value="">…</option>}
          {containers.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} — {c.role === 'app' ? '' : `${c.role}, `}
              {containerStatus(c).label.toLowerCase()}
            </option>
          ))}
        </select>
        <button
          onClick={() => setPrevious(!previous)}
          disabled={!previous && !hasPrevious}
          aria-pressed={previous}
          title={hasPrevious || previous ? 'The log of the run before the last restart — why it crashed' : 'This container has not restarted'}
          className={cn(
            'flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50',
            previous ? 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-400' : 'border-border hover:bg-muted',
          )}
        >
          <History size={12} /> Previous run
        </button>
        <button
          onClick={() => setFollow(!follow)}
          disabled={previous}
          title={previous ? 'A previous run’s log does not grow' : follow ? 'Stop following' : 'Follow new lines'}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          {following ? <Pause size={12} /> : <Play size={12} />} {following ? 'Following' : 'Follow'}
        </button>
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            aria-label="Search the log"
            className="w-36 rounded-md border border-input bg-background py-1 pl-7 pr-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <select
          value={tail}
          onChange={(e) => setTail(Number(e.target.value))}
          title="Lines of history"
          className="rounded-md border border-input bg-background px-1.5 py-1 text-xs"
        >
          {TAILS.map((t) => (
            <option key={t} value={t}>
              last {t.toLocaleString()}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} /> Times
        </label>
        <button
          onClick={() => setWrap(!wrap)}
          aria-pressed={wrap}
          title={wrap ? 'Long lines wrap' : 'Long lines scroll sideways'}
          className={cn('rounded-md border px-1.5 py-1 text-xs', wrap ? 'border-primary text-primary' : 'border-border text-muted-foreground')}
        >
          <WrapText size={12} />
        </button>
        <button onClick={download} title="Download as text" className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">
          <Download size={12} /> Download
        </button>
      </div>
      {previous && (
        <p className="mb-2 rounded-md bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          Showing the run before the last restart
          {current?.lastTermination?.reason ? ` — it ended with ${current.lastTermination.reason}` : ''}
          {current?.lastTermination?.exitCode !== null && current?.lastTermination?.exitCode !== undefined ? ` (exit ${current.lastTermination.exitCode})` : ''}.
        </p>
      )}
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        data-testid="log-lines"
        className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-zinc-950 p-2 font-mono text-xs leading-5 text-zinc-100"
      >
        {shown.map((l, i) => (
          <div key={i} className={wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}>
            {l.time && <span className="mr-2 select-none text-zinc-500">{l.time.replace('T', ' ').slice(0, 23)}</span>}
            {highlight(l.text, q)}
          </div>
        ))}
        {state === 'loading' && <p className="text-zinc-500">Loading…</p>}
        {state !== 'loading' && lines.length === 0 && !error && <p className="text-zinc-500">No log output.</p>}
        {state === 'ended' && following && lines.length > 0 && !truncated && <p className="mt-1 text-zinc-500">— the container stopped; the log ended —</p>}
        {truncated && <p className="mt-1 text-amber-400">— stopped following: this view reached its size limit. Download the log to read more. —</p>}
        {error && <p className="mt-1 text-red-400">{error}</p>}
      </div>
      <p className="mt-1 text-right text-xs text-muted-foreground">
        {q ? `${shown.length} of ${lines.length} lines` : `${lines.length} lines`}
        {lines.length >= MAX_LINES && ` (the latest ${MAX_LINES.toLocaleString()} are kept)`}
      </p>
    </div>
  );
}
