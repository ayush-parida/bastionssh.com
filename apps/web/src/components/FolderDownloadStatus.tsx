import { Loader2, X } from 'lucide-react';
import { formatBytes } from '@/lib/utils.js';
import type { ActiveFolderDownload } from '@/hooks/useFolderDownload.js';

/** The running folder download: what it is, bytes received so far, and cancel. */
export function FolderDownloadStatus({ active, onCancel }: { active: ActiveFolderDownload; onCancel: () => void }) {
  return (
    <div
      role="status"
      className="border-border bg-muted/40 mb-3 flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
    >
      <Loader2 size={14} className="text-primary shrink-0 animate-spin" />
      <span className="min-w-0 flex-1 truncate">
        Downloading <span className="font-mono">{active.name}</span>
        <span className="text-muted-foreground"> · {formatBytes(active.bytes)} received</span>
      </span>
      <button
        onClick={onCancel}
        className="border-border hover:bg-muted flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
      >
        <X size={12} /> Cancel
      </button>
    </div>
  );
}
