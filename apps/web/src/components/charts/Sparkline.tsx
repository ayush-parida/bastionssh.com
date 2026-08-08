interface SparklineProps {
  /** Newest value last. `null` marks a gap (a failed check). */
  values: (number | null)[];
  width?: number;
  height?: number;
  className?: string;
  /** Fixes the vertical scale — pass 100 for percentages so lines stay comparable. */
  max?: number;
}

/**
 * Minimal trend line for list rows. Gaps in the data break the line rather than
 * being interpolated across, so an outage is visible instead of smoothed away.
 */
export default function Sparkline({
  values,
  width = 96,
  height = 24,
  className = 'text-primary',
  max,
}: SparklineProps) {
  const points = values.filter((v): v is number => v != null);
  if (points.length < 2) {
    return <div style={{ width, height }} className="flex items-center justify-center text-[10px] text-muted-foreground">—</div>;
  }

  const top = max ?? Math.max(...points);
  const bottom = Math.min(...points, max !== undefined ? top : 0);
  const span = top - bottom || 1;
  const stepX = width / Math.max(values.length - 1, 1);

  const segments: string[] = [];
  let current: string[] = [];

  values.forEach((value, i) => {
    if (value == null) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    const x = i * stepX;
    const y = height - ((value - bottom) / span) * (height - 2) - 1;
    current.push(`${current.length === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(' '));

  return (
    <svg width={width} height={height} className={className} aria-hidden="true">
      {segments.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}
