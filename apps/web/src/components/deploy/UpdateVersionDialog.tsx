import { useState } from 'react';
import { serviceUpgradeAllowed, serviceVersionOfImage, type ServiceTemplate } from '@smt/shared';
import { ArrowUpCircle, X } from 'lucide-react';
import DocsLink from '@/components/docs/DocsLink.js';
import { serviceDocs } from '@/lib/services.js';

/**
 * Update version of a quick service (services spec §3.3): the template's
 * lines with their pinned releases. Within its line a service moves to the
 * release this BastionSSH pins (stopped, then started on the same data); a
 * database's other majors are listed but refused with the reason — the
 * server refuses them too.
 */
export default function UpdateVersionDialog({
  app,
  template,
  image,
  onUpdate,
  onClose,
}: {
  app: string;
  template: ServiceTemplate;
  /** bastion.yml's build.image now. */
  image: string;
  onUpdate: (major: string, label: string) => void;
  onClose: () => void;
}) {
  const current = serviceVersionOfImage(template, image);
  const [major, setMajor] = useState(current?.major ?? '');
  const target = template.versions.find((v) => v.major === major);
  const allowed = target ? serviceUpgradeAllowed(template, current, target) : null;
  const same = target?.image === image;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={`Update ${app}`} className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <ArrowUpCircle size={16} className="text-primary" />
          <span className="flex-1 text-sm font-semibold">Update {app}</span>
          <button onClick={onClose} title="Close" className="text-muted-foreground hover:text-foreground">
            <X size={14} />
          </button>
        </div>
        <form
          className="space-y-3 p-4 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (target && allowed?.ok && !same) onUpdate(target.major, `${target.label} (${target.version})`);
          }}
        >
          <p className="text-muted-foreground">
            Now: <span className="break-all font-mono text-xs text-foreground">{image}</span>
          </p>
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-xs text-muted-foreground">Version</legend>
            {template.versions.map((v) => {
              const ok = serviceUpgradeAllowed(template, current, v).ok;
              return (
                <label key={v.major} className="flex items-start gap-2">
                  <input type="radio" name="version" value={v.major} checked={major === v.major} onChange={() => setMajor(v.major)} className="mt-0.5" />
                  <span>
                    {v.label} <span className="font-mono text-xs">{v.version}</span>
                    {v.image === image && <span className="ml-1 text-xs text-emerald-600">current</span>}
                    {current?.major === v.major && v.image !== image && <span className="ml-1 text-xs text-primary">update available</span>}
                    {!ok && <span className="ml-1 text-xs text-muted-foreground">(needs a dump and restore)</span>}
                  </span>
                </label>
              );
            })}
          </fieldset>
          {template.imageNote && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Community-built image.</span> {template.imageNote}
            </p>
          )}
          {allowed && !allowed.ok && (
            <p role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-amber-700 dark:text-amber-400">
              {allowed.reason} <DocsLink to={serviceDocs(template.docs, 'upgrading')}>How to upgrade</DocsLink>
            </p>
          )}
          {allowed?.ok && !same && (
            <p className="text-muted-foreground">
              {template.volumes.some((v) => v.exclusive)
                ? `${app} stops, then starts on ${target!.version} with the same data: a short outage. If the new one fails its health check, the current one starts again.`
                : `${app} is replaced by ${target!.version}.`}{' '}
              {template.backup && 'Back it up first.'}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1.5 hover:bg-muted">
              Cancel
            </button>
            <button type="submit" disabled={!target || !allowed?.ok || same} className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {same ? 'Up to date' : 'Update'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
