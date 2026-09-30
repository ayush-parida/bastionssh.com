import { useEffect, useMemo, useRef, useState } from 'react';
import type { DockerLogLine } from '@smt/shared';
import { Download, Pause, Play, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { dockerPath, followDockerStream } from '@/lib/docker.js';
import { cn } from '@/lib/utils.js';

/** Lines kept in the browser; older ones scroll away (the download has everything asked for). */
const MAX_LINES = 5_000;
const TAILS = [100, 500, 2_000, 10_000];

/**
 * A container's logs, followed live over server-sent events: search filters
 * what is shown, timestamps are optional, and the download streams the same
 * tail as plain text.
 */
export default function ContainerLogs({ serverId, containerId, name }: { serverId: string; containerId: string; name: string }) {
  const [lines, setLines] = useState<DockerLogLine[]>([]);
  const [follow, setFollow] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [tail, setTail] = useState(500);
  const [search, setSearch] = useState('');
  const [state, setState] = useState<'loading' | 'live' | 'ended' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const abort = new AbortController();
    setLines([]);
    setError(null);
    setState('loading');
    const query = new URLSearchParams({ tail: String(tail), follow: follow ? '1' : '0', timestamps: timestamps ? '1' : '0' });
    followDockerStream(dockerPath(serverId, `/containers/${containerId}/logs?${query}`), abort.signal, (event) => {
      if (event.type === 'logs') {
        setState('live');
        setLines((prev) => {
          const next = prev.concat(event.lines);
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      } else if (event.type === 'end') {
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
  }, [serverId, containerId, follow, timestamps, tail]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? lines.filter((l) => l.text.toLowerCase().includes(q)) : lines;
  }, [lines, search]);

  // Keep the view at the bottom while following, unless the user scrolled up
  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown]);

  async function download() {
    try {
      const query = new URLSearchParams({ tail: String(tail), timestamps: timestamps ? '1' : '0' });
      await api.download(dockerPath(serverId, `/containers/${containerId}/logs/download?${query}`), `${name}.log`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            className="w-44 rounded-md border border-input bg-background py-1 pl-7 pr-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <button
          onClick={() => setFollow(!follow)}
          title={follow ? 'Stop following' : 'Follow new lines'}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
        >
          {follow ? <Pause size={12} /> : <Play size={12} />} {follow ? 'Following' : 'Follow'}
        </button>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} /> Timestamps
        </label>
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
        <button onClick={download} title="Download as text" className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">
          <Download size={12} /> Download
        </button>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-zinc-950 p-2 font-mono text-xs leading-5 text-zinc-100"
      >
        {shown.map((l, i) => (
          <div key={i} className={cn('whitespace-pre-wrap break-all', l.stream === 'stderr' && 'text-red-300')}>
            {l.time && <span className="mr-2 select-none text-zinc-500">{l.time.replace('T', ' ').slice(0, 23)}</span>}
            {l.text}
          </div>
        ))}
        {state === 'loading' && <p className="text-zinc-500">Loading…</p>}
        {state !== 'loading' && lines.length === 0 && !error && <p className="text-zinc-500">No log output.</p>}
        {state === 'ended' && follow && lines.length > 0 && <p className="mt-1 text-zinc-500">— the log stream ended —</p>}
        {error && <p className="mt-1 text-red-400">{error}</p>}
      </div>
      <p className="mt-1 text-right text-xs text-muted-foreground">
        {search ? `${shown.length} of ${lines.length} lines` : `${lines.length} lines`}
        {lines.length >= MAX_LINES && ` (the latest ${MAX_LINES.toLocaleString()} are kept)`}
      </p>
    </div>
  );
}
