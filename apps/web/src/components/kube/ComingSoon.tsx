import type { LucideIcon } from 'lucide-react';

/**
 * A cluster tab that a later phase fills in (spec §10). Each tab lives in its
 * own file, so that phase replaces the file's body without touching the page.
 */
export default function ComingSoon({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
      <Icon size={28} className="text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
