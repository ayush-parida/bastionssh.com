import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { downloadArchive } from '@/lib/folder-download.js';
import { formatBytes } from '@/lib/utils.js';

export interface ActiveFolderDownload {
  name: string;
  bytes: number;
}

/**
 * One folder download at a time for a file viewer: bytes received while it
 * runs, cancel, and a toast when it ends. Leaving the page cancels it, which
 * also stops the remote walk on the server.
 */
export function useFolderDownload() {
  const [active, setActive] = useState<ActiveFolderDownload | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const start = useCallback(async (path: string, name: string) => {
    if (controller.current) return;
    const ctl = new AbortController();
    controller.current = ctl;
    setActive({ name, bytes: 0 });
    try {
      const bytes = await downloadArchive(path, name, {
        signal: ctl.signal,
        onProgress: (n) => setActive((a) => (a ? { ...a, bytes: n } : a)),
      });
      toast.success(`Downloaded ${name} (${formatBytes(bytes)})`);
    } catch (err) {
      if (ctl.signal.aborted) toast.info('Download cancelled');
      else toast.error(err instanceof Error ? err.message : 'Download failed');
    } finally {
      controller.current = null;
      setActive(null);
    }
  }, []);

  const cancel = useCallback(() => controller.current?.abort(), []);

  return { active, start, cancel };
}
