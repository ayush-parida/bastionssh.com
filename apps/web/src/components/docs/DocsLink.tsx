import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils.js';

/**
 * A pointer from a page of the app into the Docs (`/docs/<section>/<slug>#anchor`).
 * It opens in a new tab, so a half-done form or a deploy log stays where it is.
 */
export default function DocsLink({ to, children, className, icon = true }: { to: string; children: ReactNode; className?: string; icon?: boolean }) {
  return (
    <Link to={to} target="_blank" rel="noopener" className={cn('inline-flex items-center gap-1 text-primary hover:underline', className)}>
      {icon && <BookOpen size={13} className="shrink-0" />}
      {children}
    </Link>
  );
}
