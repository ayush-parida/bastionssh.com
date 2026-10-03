import { ChevronRight, Copy } from 'lucide-react';
import { toast } from 'sonner';

/**
 * The collapsible "What this does" of every action (spec §2.2): what changes
 * on the cluster in a sentence, and the kubectl command it is equivalent to —
 * for learning and auditing. Nothing ever runs the command; BastionSSH sends
 * the change to the API server itself.
 */
export default function WhatThisDoes({ command, children }: { command: string; children?: React.ReactNode }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      toast.success('Command copied');
    } catch {
      toast.message('Select the command to copy it');
    }
  }

  return (
    <details className="group rounded-md border border-border text-xs" data-testid="what-this-does">
      <summary className="flex cursor-pointer select-none list-none items-center gap-1 px-3 py-2 text-muted-foreground hover:text-foreground">
        <ChevronRight size={12} className="transition-transform group-open:rotate-90" /> What this does
      </summary>
      <div className="space-y-2 border-t border-border px-3 py-2">
        {children && <div className="text-muted-foreground">{children}</div>}
        <p className="text-muted-foreground">The same change with kubectl (for reference — nothing runs it):</p>
        <div className="flex items-start gap-2 rounded bg-muted px-2 py-1.5">
          <code className="min-w-0 flex-1 break-all font-mono" data-testid="action-command">
            {command}
          </code>
          <button type="button" onClick={() => void copy()} className="shrink-0 text-muted-foreground hover:text-foreground" title="Copy">
            <Copy size={12} />
          </button>
        </div>
      </div>
    </details>
  );
}
