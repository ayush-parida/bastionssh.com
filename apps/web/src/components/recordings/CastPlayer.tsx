import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils.js';

/**
 * A minimal asciicast v2 player on xterm.js: play/pause, speed, seek, and idle
 * compression so a session left open over lunch does not play back in real
 * time. Seeking replays every output event up to the target into a fresh
 * terminal, which is instant for anything a person could have typed.
 */

type CastEvent = [time: number, code: string, data: string];

export interface ParsedCast {
  width: number;
  height: number;
  /** Output and resize events, on the idle-compressed timeline. */
  events: CastEvent[];
  /** Markers (commands run over the session, the truncation point). */
  markers: { time: number; label: string }[];
  duration: number;
}

/** Pauses longer than this play back as this long. */
const IDLE_LIMIT_S = 2;

const SPEEDS = [0.5, 1, 2, 4, 8];

export function parseCast(text: string): ParsedCast {
  const lines = text.split('\n').filter((l) => l.trim());
  const header = JSON.parse(lines[0] ?? '{}') as { version?: number; width?: number; height?: number };
  if (header.version !== 2) throw new Error('Not an asciicast v2 recording');

  const events: CastEvent[] = [];
  const markers: ParsedCast['markers'] = [];
  let last = 0;
  let shift = 0;
  for (const line of lines.slice(1)) {
    let event: CastEvent;
    try {
      event = JSON.parse(line) as CastEvent;
    } catch {
      continue; // a live recording's last line may be half-written
    }
    const [time, code, data] = event;
    const gap = time - last;
    if (gap > IDLE_LIMIT_S) shift += gap - IDLE_LIMIT_S;
    last = time;
    const t = time - shift;
    if (code === 'o' || code === 'r') events.push([t, code, data]);
    else if (code === 'm') markers.push({ time: t, label: data });
  }
  const end = Math.max(events.at(-1)?.[0] ?? 0, markers.at(-1)?.time ?? 0);
  return { width: header.width ?? 80, height: header.height ?? 24, events, markers, duration: end };
}

function formatTime(s: number) {
  const total = Math.max(0, Math.floor(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function parseSize(data: string): [number, number] | null {
  const match = /^(\d+)x(\d+)$/.exec(data);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export interface CastPlayerHandle {
  /** Jump to a point on the (idle-compressed) timeline, in seconds. */
  seek(time: number): void;
}

interface CastPlayerProps {
  cast: ParsedCast;
  className?: string;
}

const CastPlayer = forwardRef<CastPlayerHandle, CastPlayerProps>(({ cast, className }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  /** Index of the next event to write. */
  const cursorRef = useRef(0);
  /** Playback clock: position `base` at wall time `wall`. */
  const clockRef = useRef({ base: 0, wall: 0 });
  const frameRef = useRef<number | null>(null);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [position, setPosition] = useState(0);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      cols: cast.width,
      rows: cast.height,
      disableStdin: true,
      cursorBlink: false,
      convertEol: false,
      scrollback: 5000,
      fontFamily: 'JetBrains Mono, Fira Code, Cascadia Code, monospace',
      fontSize: 13,
      theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff', selectionBackground: '#264f78' },
    });
    term.open(containerRef.current);
    termRef.current = term;
    cursorRef.current = 0;
    setPosition(0);
    setPlaying(false);
    return () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      term.dispose();
      termRef.current = null;
    };
  }, [cast]);

  /** Write every event up to `time`, batched into one write. */
  const advanceTo = useCallback(
    (time: number) => {
      const term = termRef.current;
      if (!term) return;
      let chunk = '';
      while (cursorRef.current < cast.events.length && cast.events[cursorRef.current]![0] <= time) {
        const [, code, data] = cast.events[cursorRef.current++]!;
        if (code === 'o') {
          chunk += data;
        } else {
          const size = parseSize(data);
          if (size) {
            if (chunk) term.write(chunk);
            chunk = '';
            term.resize(size[0], size[1]);
          }
        }
      }
      if (chunk) term.write(chunk);
    },
    [cast],
  );

  const stopLoop = useCallback(() => {
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const tick = useCallback(() => {
    const { base, wall } = clockRef.current;
    const now = Math.min(cast.duration, base + ((performance.now() - wall) / 1000) * speedRef.current);
    advanceTo(now);
    setPosition(now);
    if (now >= cast.duration) {
      setPlaying(false);
      frameRef.current = null;
      return;
    }
    frameRef.current = requestAnimationFrame(tick);
  }, [advanceTo, cast.duration]);

  const seek = useCallback(
    (time: number) => {
      const term = termRef.current;
      if (!term) return;
      const target = Math.max(0, Math.min(cast.duration, time));
      if (target < position || cursorRef.current === 0) {
        term.reset();
        term.resize(cast.width, cast.height);
        cursorRef.current = 0;
      }
      advanceTo(target);
      setPosition(target);
      clockRef.current = { base: target, wall: performance.now() };
    },
    [advanceTo, cast, position],
  );

  useImperativeHandle(ref, () => ({ seek }), [seek]);

  function play() {
    // Replay from the start once it has finished
    const from = position >= cast.duration ? 0 : position;
    if (from === 0 && position !== 0) seek(0);
    clockRef.current = { base: from, wall: performance.now() };
    setPlaying(true);
    stopLoop();
    frameRef.current = requestAnimationFrame(tick);
  }

  function pause() {
    stopLoop();
    setPlaying(false);
  }

  function changeSpeed(next: number) {
    // Re-anchor so the change applies from here, not retroactively
    clockRef.current = { base: position, wall: performance.now() };
    setSpeed(next);
  }

  useEffect(() => stopLoop, [stopLoop]);

  const markerPositions = useMemo(
    () =>
      cast.duration > 0
        ? cast.markers.map((m) => ({ ...m, left: `${(m.time / cast.duration) * 100}%` }))
        : [],
    [cast],
  );

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-lg border border-[#30363d] bg-[#0d1117]', className)}>
      <div className="overflow-auto p-3">
        <div ref={containerRef} className="inline-block" />
      </div>

      <div className="flex items-center gap-3 border-t border-[#30363d] bg-[#161b22] px-3 py-2 text-xs text-[#8b949e]">
        <button
          onClick={playing ? pause : play}
          title={playing ? 'Pause' : 'Play'}
          className="rounded p-1 text-[#e6edf3] hover:bg-[#21262d]"
        >
          {playing ? <Pause size={14} /> : position >= cast.duration && position > 0 ? <RotateCcw size={14} /> : <Play size={14} />}
        </button>
        <span className="w-24 shrink-0 font-mono tabular-nums">
          {formatTime(position)} / {formatTime(cast.duration)}
        </span>

        <div className="relative flex-1">
          <input
            type="range"
            min={0}
            max={cast.duration || 0}
            step={0.1}
            value={position}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Seek"
            className="w-full accent-[#58a6ff]"
          />
          {markerPositions.map((m, i) => (
            <button
              key={i}
              onClick={() => seek(m.time)}
              title={m.label}
              style={{ left: m.left }}
              className="absolute -top-1 h-2 w-1 -translate-x-1/2 rounded-sm bg-[#d29922] hover:bg-[#e3b341]"
            />
          ))}
        </div>

        <select
          value={speed}
          onChange={(e) => changeSpeed(Number(e.target.value))}
          aria-label="Playback speed"
          className="rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 text-[#e6edf3]"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </div>
    </div>
  );
});

CastPlayer.displayName = 'CastPlayer';
export default CastPlayer;
