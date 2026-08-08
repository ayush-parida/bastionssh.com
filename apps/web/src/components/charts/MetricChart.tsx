import { useMemo, useState } from 'react';

export interface ChartPoint {
  t: string;
  /** `null` renders as a gap — the server was unreachable at that moment. */
  v: number | null;
}

export interface ChartSeries {
  label: string;
  color: string;
  points: ChartPoint[];
}

interface MetricChartProps {
  series: ChartSeries[];
  height?: number;
  /** Fixed upper bound (100 for percentages); otherwise scaled to the data. */
  max?: number;
  unit?: string;
  formatValue?: (value: number) => string;
  emptyMessage?: string;
}

const PADDING = { top: 8, right: 8, bottom: 20, left: 40 };
const VIEW_WIDTH = 720;

function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

/**
 * Multi-series time chart drawn as inline SVG — deliberately dependency-free.
 * Uses a fixed viewBox and scales to its container, so it stays sharp at any
 * width without needing a resize observer.
 */
export default function MetricChart({
  series,
  height = 180,
  max,
  unit = '',
  formatValue,
  emptyMessage = 'No data for this range yet.',
}: MetricChartProps) {
  const [hover, setHover] = useState<number | null>(null);

  const { scaleTop, plotWidth, plotHeight, timestamps } = useMemo(() => {
    const all = series.flatMap((s) => s.points.map((p) => p.v)).filter((v): v is number => v != null);
    const dataMax = all.length ? Math.max(...all) : 0;
    return {
      scaleTop: max ?? niceCeiling(dataMax || 1),
      plotWidth: VIEW_WIDTH - PADDING.left - PADDING.right,
      plotHeight: height - PADDING.top - PADDING.bottom,
      timestamps: series[0]?.points.map((p) => p.t) ?? [],
    };
  }, [series, max, height]);

  const count = timestamps.length;
  if (count === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
        {emptyMessage}
      </div>
    );
  }

  const format = formatValue ?? ((v: number) => `${Math.round(v * 10) / 10}${unit}`);
  const x = (i: number) => PADDING.left + (count === 1 ? plotWidth / 2 : (i / (count - 1)) * plotWidth);
  const y = (v: number) => PADDING.top + plotHeight - (Math.min(v, scaleTop) / scaleTop) * plotHeight;

  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  function pathFor(points: ChartPoint[]): string[] {
    const segments: string[] = [];
    let current: string[] = [];
    points.forEach((p, i) => {
      if (p.v == null) {
        if (current.length > 1) segments.push(current.join(' '));
        current = [];
        return;
      }
      current.push(`${current.length === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`);
    });
    if (current.length > 1) segments.push(current.join(' '));
    else if (current.length === 1) segments.push(`${current[0]} l0.01,0`); // lone point
    return segments;
  }

  const hoverIndex = hover != null ? Math.min(Math.max(hover, 0), count - 1) : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientX - rect.left) / rect.width;
          const svgX = ratio * VIEW_WIDTH;
          setHover(Math.round(((svgX - PADDING.left) / plotWidth) * (count - 1)));
        }}
      >
        {gridLines.map((g) => {
          const gy = PADDING.top + plotHeight * g;
          return (
            <g key={g}>
              <line
                x1={PADDING.left}
                x2={VIEW_WIDTH - PADDING.right}
                y1={gy}
                y2={gy}
                stroke="currentColor"
                className="text-border"
                strokeWidth={1}
                strokeDasharray={g === 1 ? undefined : '3 3'}
              />
              <text
                x={PADDING.left - 6}
                y={gy + 3}
                textAnchor="end"
                className="fill-muted-foreground"
                style={{ fontSize: 9 }}
              >
                {format(scaleTop * (1 - g))}
              </text>
            </g>
          );
        })}

        {series.map((s) =>
          pathFor(s.points).map((d, i) => (
            <path
              key={`${s.label}-${i}`}
              d={d}
              fill="none"
              stroke={s.color}
              strokeWidth={1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )),
        )}

        {hoverIndex != null && (
          <line
            x1={x(hoverIndex)}
            x2={x(hoverIndex)}
            y1={PADDING.top}
            y2={PADDING.top + plotHeight}
            stroke="currentColor"
            className="text-muted-foreground"
            strokeWidth={1}
          />
        )}

        {[0, count - 1].map((i, idx) =>
          timestamps[i] ? (
            <text
              key={i}
              x={idx === 0 ? PADDING.left : VIEW_WIDTH - PADDING.right}
              y={height - 6}
              textAnchor={idx === 0 ? 'start' : 'end'}
              className="fill-muted-foreground"
              style={{ fontSize: 9 }}
            >
              {new Date(timestamps[i]!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </text>
          ) : null,
        )}
      </svg>

      {hoverIndex != null && timestamps[hoverIndex] && (
        <div
          className="pointer-events-none absolute top-1 rounded-md border border-border bg-card px-2 py-1 text-xs shadow-lg"
          style={{
            left: `${Math.min(Math.max((x(hoverIndex) / VIEW_WIDTH) * 100, 2), 78)}%`,
          }}
        >
          <p className="mb-0.5 font-medium">
            {new Date(timestamps[hoverIndex]!).toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
          {series.map((s) => {
            const point = s.points[hoverIndex];
            return (
              <p key={s.label} className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="size-2 rounded-full" style={{ background: s.color }} />
                <span className="text-muted-foreground">{s.label}</span>
                <span className="ml-auto font-mono">
                  {point?.v == null ? 'no data' : format(point.v)}
                </span>
              </p>
            );
          })}
        </div>
      )}

      {series.length > 1 && (
        <div className="mt-1 flex flex-wrap gap-3 pl-10">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-2 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
