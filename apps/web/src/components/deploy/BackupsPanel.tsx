import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { serviceTemplate, type DeployBackup, type DeployBackupList, type DeployBackupResult, type DeployBackupSchedule, type DeployRestoreResult } from '@smt/shared';
import { ArchiveRestore, DatabaseBackup, Download, Loader2, Trash2, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { appPath, deployKeys, when } from '@/lib/deploy.js';
import { passkeyErrorMessage, withStepUp } from '@/lib/passkeys.js';
import { formatBytes } from '@/lib/utils.js';
import { SERVICE_DOCS, serviceDocs } from '@/lib/services.js';
import ConfirmDialog from '@/components/docker/ConfirmDialog.js';
import DocsLink from '@/components/docs/DocsLink.js';

const KIND_LABEL: Record<DeployBackup['kind'], string> = { manual: 'By hand', scheduled: 'Scheduled', 'pre-restore': 'Before a restore' };

/** Restore needs the service's name typed: it replaces the data apps are using. */
function RestoreDialog({ app, file, onConfirm, onClose }: { app: string; file: string; onConfirm: () => Promise<unknown>; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="alertdialog" aria-modal="true" aria-label={`Restore ${app}`} className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <TriangleAlert size={16} className="text-red-500" />
          <span className="flex-1 text-sm font-semibold">Restore {app}</span>
          <button onClick={onClose} disabled={busy} title="Close" className="text-muted-foreground hover:text-foreground disabled:opacity-40">
            <X size={14} />
          </button>
        </div>
        <form
          className="space-y-3 p-4 text-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setBusy(false);
            }
          }}
        >
          <p>
            The data of <span className="font-mono">{app}</span> is replaced by <span className="font-mono">{file}</span>. A backup of the data as it is now is made first.
          </p>
          <p className="text-muted-foreground">
            Apps using {app} keep running and may see errors while it restores; stop them first if they must not write meanwhile.{' '}
            <DocsLink to={SERVICE_DOCS.restoring}>More</DocsLink>
          </p>
          <label className="block">
            <span className="text-xs text-muted-foreground">
              Type <span className="font-mono">{app}</span> to confirm
            </span>
            <input
              autoFocus
              aria-label="Service name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>
          {error && <p className="whitespace-pre-wrap break-words rounded-md bg-red-500/10 px-3 py-2 text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-3 py-1.5 hover:bg-muted disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={busy || typed !== app} className="flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50">
              {busy && <Loader2 size={13} className="animate-spin" />}
              Restore
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * A database service's Backups tab (services spec §3.4): back up now, the
 * files with their size and time, download (a passkey confirmation, like a
 * reveal), restore (the name typed) and delete, and the schedule bastion-cron
 * runs on the server with how many backups are kept. Every file stays on the
 * server, in the service's backups folder.
 */
export default function BackupsPanel({ serverId, app, canOperate, canManage }: { serverId: string; app: string; canOperate: boolean; canManage: boolean }) {
  const qc = useQueryClient();
  const list = useQuery<DeployBackupList>({ queryKey: deployKeys.backups(serverId, app), queryFn: () => api.get(appPath(serverId, app, '/backups')), retry: false });
  const [restoring, setRestoring] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<DeployBackupSchedule>('off');
  const [keep, setKeep] = useState('7');
  const settings = list.data?.settings;
  useEffect(() => {
    if (!settings) return;
    setSchedule(settings.schedule);
    setKeep(String(settings.keep));
  }, [settings]);
  const refresh = () => qc.invalidateQueries({ queryKey: deployKeys.backups(serverId, app) });

  const backupNow = useMutation({
    mutationFn: () => api.post<DeployBackupResult>(appPath(serverId, app, '/backups')),
    onSuccess: (r) => {
      toast.success(`Backed up ${app}: ${r.backup.file} (${formatBytes(r.backup.bytes)})${r.pruned.length ? `; ${r.pruned.length} old one${r.pruned.length === 1 ? '' : 's'} removed` : ''}`);
      void refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });
  const saveSchedule = useMutation({
    mutationFn: () => api.put<{ settings: { schedule: string; keep: number } }>(appPath(serverId, app, '/backups/schedule'), { schedule, keep: Number(keep) }),
    onSuccess: (r) => {
      toast.success(r.settings.schedule === 'off' ? 'Scheduled backups are off' : `Backing up ${r.settings.schedule}, keeping ${r.settings.keep}`);
      void refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });

  const download = async (file: string) => {
    setDownloading(file);
    try {
      await withStepUp(() => api.download(appPath(serverId, app, `/backups/${encodeURIComponent(file)}`), `${app}-${file}`));
    } catch (err) {
      toast.error(passkeyErrorMessage(err));
    } finally {
      setDownloading(null);
    }
  };

  if (list.isLoading) return <p className="text-sm text-muted-foreground">Reading backups from the server…</p>;
  if (list.error || !list.data) return <p className="text-sm text-red-600">{list.error ? (list.error as Error).message : 'No backups'}</p>;
  const b = list.data;
  if (!b.supported) {
    // Its own page says how (SeaweedFS, MinIO: copy the objects out); every template's page has a Backups section
    const t = serviceTemplate(b.service);
    return (
      <p className="text-sm text-muted-foreground">
        This service has no backup command. <DocsLink to={t ? serviceDocs(t.docs, 'backups') : SERVICE_DOCS.noBackups}>How to back it up</DocsLink>
      </p>
    );
  }
  const keepValid = /^\d{1,3}$/.test(keep) && Number(keep) >= 1 && Number(keep) <= 100;
  const dirty = !!settings && (settings.schedule !== schedule || String(settings.keep) !== keep);

  return (
    <div className="space-y-5">
      <section aria-label="Backups" className="rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <DatabaseBackup size={15} className="text-primary" />
          <h3 className="font-semibold">Backups</h3>
          <span className="text-xs text-muted-foreground">{b.backups.length} on the server</span>
          {canOperate && (
            <button
              onClick={() => backupNow.mutate()}
              disabled={backupNow.isPending}
              className="ml-auto flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {backupNow.isPending ? <Loader2 size={14} className="animate-spin" /> : <DatabaseBackup size={14} />}
              {backupNow.isPending ? 'Backing up…' : 'Back up now'}
            </button>
          )}
        </div>
        {b.backups.length === 0 ? (
          <p className="px-4 py-5 text-sm text-muted-foreground">No backups yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Made</th>
                <th className="px-4 py-2 font-medium">File</th>
                <th className="px-4 py-2 font-medium">Size</th>
                <th className="px-4 py-2 font-medium">Kind</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {b.backups.map((x) => (
                <tr key={x.file} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 whitespace-nowrap">{when(x.createdAt)}</td>
                  <td className="px-4 py-2 font-mono text-xs">{x.file}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{formatBytes(x.bytes)}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{KIND_LABEL[x.kind]}</td>
                  <td className="px-4 py-2">
                    {canManage && (
                      <span className="flex justify-end gap-1">
                        <button onClick={() => void download(x.file)} disabled={downloading !== null} aria-label={`Download ${x.file}`} title="Download (asks for your passkey)" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
                          {downloading === x.file ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                        </button>
                        <button onClick={() => setRestoring(x.file)} aria-label={`Restore ${x.file}`} title="Restore" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                          <ArchiveRestore size={14} />
                        </button>
                        <button onClick={() => setDeleting(x.file)} aria-label={`Delete ${x.file}`} title="Delete" className="rounded p-1 text-red-500 hover:bg-red-500/10">
                          <Trash2 size={14} />
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Schedule" className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm">
        <h3 className="font-semibold">Schedule</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-xs text-muted-foreground">Back up</span>
            <select
              aria-label="Backup schedule"
              value={schedule}
              disabled={!canManage}
              onChange={(e) => setSchedule(e.target.value as DeployBackupSchedule)}
              className="mt-1 block rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
            >
              <option value="off">Only by hand</option>
              <option value="hourly">Every hour</option>
              <option value="daily">Every day</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Keep the newest</span>
            <input aria-label="Backups kept" value={keep} disabled={!canManage} onChange={(e) => setKeep(e.target.value.trim())} className="mt-1 block w-20 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm" />
          </label>
          {canManage && (
            <button onClick={() => saveSchedule.mutate()} disabled={!dirty || !keepValid || saveSchedule.isPending} className="rounded-md border border-border px-3 py-1.5 hover:bg-muted disabled:opacity-50">
              {saveSchedule.isPending ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
        {!keepValid && <p className="text-xs text-red-600">From 1 to 100</p>}
        <p className="text-xs text-muted-foreground">
          {b.settings.schedule === 'off'
            ? 'Not scheduled.'
            : `The bastion-cron container on the server runs it (${b.cron ? b.cron.state : 'not running — set up the server again'}); the oldest are removed beyond ${b.settings.keep}.`}
          {b.lastScheduled &&
            ` Last scheduled run ${when(b.lastScheduled.at)}: ${b.lastScheduled.result === 'success' ? b.lastScheduled.file : `failed — ${b.lastScheduled.error}`}.`}{' '}
          Backups stay on the server in <span className="font-mono">apps/{app}/backups/</span>; copy them elsewhere too. <DocsLink to={SERVICE_DOCS.backups}>How backups work</DocsLink>
        </p>
      </section>

      {restoring && (
        <RestoreDialog
          app={app}
          file={restoring}
          onConfirm={async () => {
            const r = await api.post<DeployRestoreResult>(appPath(serverId, app, `/backups/${encodeURIComponent(restoring)}/restore`), { confirm: app });
            toast.success(`Restored ${app} from ${r.file}${r.safety ? `; the data before is in ${r.safety.file}` : ''}`);
            await refresh();
          }}
          onClose={() => setRestoring(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete backup"
          subject={deleting}
          confirmLabel="Delete"
          onConfirm={async () => {
            await api.delete(appPath(serverId, app, `/backups/${encodeURIComponent(deleting)}`));
            toast.success(`${deleting} deleted`);
            await refresh();
          }}
          onClose={() => setDeleting(null)}
        >
          <p>The file is removed from the server. This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
