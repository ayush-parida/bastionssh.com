import type { AccessLevel, AccessReason } from '@smt/shared';
import { cn } from '@/lib/utils.js';
import { LEVEL_LABELS, remaining } from '@/lib/access.js';

const LEVEL_STYLE: Record<AccessLevel, string> = {
  view: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  operate: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  manage: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
};

export function LevelBadge({ level, className }: { level: AccessLevel | null; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-medium',
        level ? LEVEL_STYLE[level] : 'bg-muted text-muted-foreground',
        className,
      )}
    >
      {level ? LEVEL_LABELS[level] : 'No access'}
    </span>
  );
}

/** A role's colour as a small dot. */
export function RoleDot({ color }: { color: string | null | undefined }) {
  return <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: color ?? '#94a3b8' }} />;
}

/** "personal, expires in 3h" / "via Web team (tag: frontend)" / "base role: operator". */
export function reasonText(reason: AccessReason): string {
  const parts: string[] = [];
  if (reason.kind === 'base') parts.push(`base role: ${reason.name}`);
  else if (reason.kind === 'role') parts.push(`via ${reason.name}`);
  else parts.push('personal');
  if (reason.selector === 'tag' && reason.tag) parts.push(`tag: ${reason.tag}`);
  else if (reason.selector === 'all' && reason.kind !== 'base') parts.push('all of this type');
  if (reason.namespaces?.length) parts.push(`ns: ${reason.namespaces.join(', ')}`);
  if (reason.expiresAt) {
    const left = remaining(reason.expiresAt);
    parts.push(left ? `expires in ${left}` : 'expired');
  }
  return parts.join(', ');
}

/** Where a level comes from, as a badge: "via Web team", "personal, expires in 3h". */
export function ViaBadge({ reason, color }: { reason: AccessReason; color?: string | null }) {
  return (
    <span
      title={`${LEVEL_LABELS[reason.level]} — ${reasonText(reason)}`}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-xs',
        reason.kind === 'base'
          ? 'border-border text-muted-foreground'
          : reason.kind === 'role'
            ? 'border-primary/30 bg-primary/5 text-foreground'
            : 'border-violet-500/30 bg-violet-500/5 text-violet-700 dark:text-violet-300',
      )}
    >
      {reason.kind === 'role' && <RoleDot color={color} />}
      <span className="truncate">{reasonText(reason)}</span>
      <span className="text-muted-foreground">· {LEVEL_LABELS[reason.level].toLowerCase()}</span>
    </span>
  );
}
