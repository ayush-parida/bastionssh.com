import { useEffect, useMemo, useRef, useState } from 'react';
import type { DockerComposeProject, DockerLogLine } from '@smt/shared';
import { Pause, Play, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { dockerPath, followDockerStream } from '@/lib/docker.js';

const MAX_LINES = 5_000;
const TAILS = [50, 200, 1_000, 5_000];
/** Stable colours per source, like `docker compose logs`. */
const SOURCE_COLOURS = ['text-sky-400', 'text-emerald-400', 'text-amber-400', 'text-fuchsia-400', 'text-cyan-400', 'text-rose-400', 'text-lime-400', 'text-violet-400'];

function colourOf(source: string, sources: string[]): string {
  const i = sources.indexOf(source);
  return SOURCE_COLOURS[(i === -1 ? 0 : i) % SOURCE_COLOURS.length]!;
}

/**
 * A compose project's logs, every container merged into one stream with a
 * `service-N |` prefix, followed live. One service can be picked out.
 */
export default function ComposeLogs({
  serverId,
  project,
  onClose,
}: {
  serverId: string;
  project: DockerComposeProject;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<DockerLogLine[]>([]);
  const [service, setService] = useState('');
  const [follow, setFollow] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [tail, setTail] = useState(200);
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
    if (service) query.set('service', service);
    followDockerStream(dockerPath(serverId, `/compose/${encodeURIComponent(project.name)}/logs?${query}`), abort.signal, (event) => {
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
  }, [serverId, project.name, service, follow, timestamps, tail]);

  const sources = useMemo(() => [...new Set(lines.map((l) => l.source ?? ''))].sort(), [lines]);
  const width = Math.max(0, ...sources.map((s) => s.length));
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? lines.filter((l) => l.text.toLowerCase().includes(q)) : lines;
  }, [lines, search]);

  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Logs of ${project.name}`}
        className="flex h-full w-full max-w-4xl flex-col border-l border-border bg-card shadow-xl"
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold">{project.name}</p>
            <p className="text-xs text-muted-foreground">Logs of every container in the project, merged</p>
          </div>
          <button onClick={onClose} title="Close" className="text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col p-5">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <select
              value={service}
              onChange={(e) => setService(e.target.value)}
              title="Service"
              className="rounded-md border border-input bg-background px-1.5 py-1 text-xs"
            >
              <option value="">All services</option>
              {project.services.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
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
              title="Lines of history per container"
              className="rounded-md border border-input bg-background px-1.5 py-1 text-xs"
            >
              {TAILS.map((t) => (
                <option key={t} value={t}>
                  last {t.toLocaleString()} each
                </option>
              ))}
            </select>
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
                <span className={cn('select-none', colourOf(l.source ?? '', sources))}>
                  {(l.source ?? '').padEnd(width)} |{' '}
                </span>
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
      </aside>
    </div>
  );
}
