import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils.js';

/**
 * Replicas as rings, one segment per pod — the "current → new" picture the
 * scale panel shows (spec §6). On the current ring the pods that stop are
 * red; on the new ring the pods that start are blue. Zero
 * replicas is an empty dashed ring.
 */

type Segment = 'ready' | 'starting' | 'added' | 'removed';

const SEGMENT_CLASS: Record<Segment, string> = {
  ready: 'stroke-emerald-500',
  starting: 'stroke-amber-500',
  added: 'stroke-sky-400',
  removed: 'stroke-red-500 opacity-60',
};

function point(cx: number, r: number, angle: number) {
  return `${(cx + r * Math.cos(angle)).toFixed(2)} ${(cx + r * Math.sin(angle)).toFixed(2)}`;
}

export function SegmentRing({
  segments,
  label,
  caption,
  size = 96,
  testId,
}: {
  segments: Segment[];
  label: string;
  caption: string;
  size?: number;
  testId?: string;
}) {
  const c = size / 2;
  const r = c - 6;
  const n = segments.length;
  // A visible gap between segments while they are big enough to count
  const gap = n > 1 && n <= 48 ? Math.min(0.12, (Math.PI * 2) / n / 4) : 0;
  return (
    <div className="flex flex-col items-center gap-1" data-testid={testId} data-replicas={n}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          {n === 0 ? (
            <circle cx={c} cy={c} r={r} className="fill-none stroke-muted-foreground/40" strokeWidth={2} strokeDasharray="4 4" />
          ) : n === 1 ? (
            <circle
              cx={c}
              cy={c}
              r={r}
              className={cn('fill-none', SEGMENT_CLASS[segments[0]!])}
              strokeWidth={6}
            />
          ) : (
            segments.map((s, i) => {
              const a0 = -Math.PI / 2 + (i * Math.PI * 2) / n + gap / 2;
              const a1 = -Math.PI / 2 + ((i + 1) * Math.PI * 2) / n - gap / 2;
              return (
                <path
                  key={i}
                  data-segment={s}
                  d={`M ${point(c, r, a0)} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${point(c, r, a1)}`}
                  className={cn('fill-none', SEGMENT_CLASS[s])}
                  strokeWidth={6}
                />
              );
            })
          )}
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-xl font-semibold tabular-nums">{label}</span>
      </div>
      <span className="text-xs text-muted-foreground">{caption}</span>
    </div>
  );
}

/** Current replicas (with how many are ready) → the new count. */
export default function ReplicaChange({ current, ready, next }: { current: number; ready: number; next: number }) {
  const before: Segment[] = Array.from({ length: current }, (_, i) => (i >= next ? 'removed' : i < ready ? 'ready' : 'starting'));
  const after: Segment[] = Array.from({ length: next }, (_, i) => (i >= current ? 'added' : i < ready ? 'ready' : 'starting'));
  const delta = next - current;
  return (
    <div className="space-y-2" data-testid="replica-change">
      <div className="flex items-center justify-center gap-4">
        <SegmentRing segments={before} label={String(current)} caption="now" testId="replicas-now" />
        <ArrowRight size={18} className="text-muted-foreground" />
        <SegmentRing segments={after} label={String(next)} caption="after" testId="replicas-after" />
      </div>
      <p className="text-center text-xs text-muted-foreground" data-testid="replica-delta">
        {delta > 0
          ? `${delta} new pod${delta === 1 ? '' : 's'} will start`
          : delta < 0
            ? `${-delta} pod${delta === -1 ? '' : 's'} will stop${next === 0 ? ' — nothing will run' : ''}`
            : 'No change'}
      </p>
    </div>
  );
}
