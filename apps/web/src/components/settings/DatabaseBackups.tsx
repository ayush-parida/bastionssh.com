import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { formatBytes, relativeTime } from '@/lib/utils.js';
import { isPasskeyCancel, passkeyErrorMessage, withStepUp } from '@/lib/passkeys.js';
import { useHasRole } from '@/store/auth.js';
import type { CreatedDbBackup, DbBackupList, DbBackupReason } from '@smt/shared';
import { DatabaseBackup, Download, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';

const QUERY_KEY = ['db-backups'];

const REASON_LABELS: Record<DbBackupReason, string> = {
  scheduled: 'Scheduled',
  'pre-migration': 'Before upgrade',
  manual: 'Manual',
  'pre-restore': 'Before restore',
};

/**
 * Backups of the app's own database. Owners of the instance's organization
 * only: the server answers 403 to anyone else, and the section stays hidden.
 */
export default function DatabaseBackups() {
  const isOwner = useHasRole('owner');
  if (!isOwner) return null;
  return <BackupsSection />;
}

function BackupsSection() {
  const qc = useQueryClient();
  const [downloading, setDownloading] = useState<string | null>(null);

  const { data, isError } = useQuery<DbBackupList>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/admin/backups'),
    retry: false,
  });

  const createMutation = useMutation({
    mutationFn: () => api.post<CreatedDbBackup>('/admin/backups'),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      if (res.uploaded === false) toast.warning('Backup created, but copying it to object storage failed');
      else toast.success('Backup created');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  async function download(name: string) {
    setDownloading(name);
    try {
      // The whole database: confirm a passkey first when the account has one
      await withStepUp(() => api.download(`/admin/backups/${encodeURIComponent(name)}/download`, name));
    } catch (err) {
      if (!isPasskeyCancel(err)) toast.error(passkeyErrorMessage(err, 'Download failed'));
    } finally {
      setDownloading(null);
    }
  }

  // Owners of another organization on this instance cannot see its backups
  if (isError || !data) return null;
  const { backups, settings } = data;

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold">Database backups</h2>
        <button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {createMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Back up now
        </button>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        {settings.intervalHours > 0
          ? `Every ${settings.intervalHours} hour${settings.intervalHours === 1 ? '' : 's'}`
          : 'Scheduled backups are off'}
        {settings.preMigration && ', and before every upgrade'}. The newest {settings.keep} of each kind are kept in{' '}
        <code className="font-mono text-xs">{settings.directory}</code>
        {settings.upload && (
          <>
            {' '}and copied, encrypted, to <code className="font-mono text-xs">{settings.upload.bucket}/{settings.upload.prefix}</code>
          </>
        )}
        . Backups hold every account and encrypted credential on this instance; sign-in sessions and invite links are left out.
      </p>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {backups.length === 0 ? (
          <div className="flex flex-col items-center py-12 text-muted-foreground">
            <DatabaseBackup size={36} className="mb-3 opacity-30" />
            <p className="text-sm">No backups yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {backups.map((b) => (
              <div key={b.name} className="flex items-center gap-3 px-4 py-3">
                <DatabaseBackup size={16} className="shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate font-mono">{b.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {REASON_LABELS[b.reason]} · <span title={new Date(b.createdAt).toLocaleString()}>{relativeTime(b.createdAt)}</span> · {formatBytes(b.size)}
                    {b.compressed && ' · gzip'}
                  </p>
                </div>
                <button
                  onClick={() => download(b.name)}
                  disabled={downloading !== null}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                  title="Download"
                >
                  {downloading === b.name ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        To restore, stop the server and run <code className="font-mono">db:restore</code> with the backup's name — see the README.
      </p>
    </section>
  );
}
