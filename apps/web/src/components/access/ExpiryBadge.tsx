import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { remaining } from '@/lib/access.js';

/** Re-render every `ms`, for countdowns. */
function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** "2h 15m left" on a time-bound grant; amber in its last quarter hour, muted once over. */
export function ExpiryBadge({ expiresAt, className }: { expiresAt: string; className?: string }) {
  const now = useNow();
  const left = remaining(expiresAt, now);
  const soon = new Date(expiresAt).getTime() - now < 15 * 60_000;
  return (
    <span
      title={`Access ends ${new Date(expiresAt).toLocaleString()}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs whitespace-nowrap',
        !left
          ? 'bg-muted text-muted-foreground line-through'
          : soon
            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
            : 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
        className,
      )}
    >
      <Timer size={11} />
      {left ? `${left} left` : 'Expired'}
    </span>
  );
}
