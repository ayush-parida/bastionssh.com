import { useState } from 'react';
import { DEPLOY_NAME_PATTERN, type DeployProxyMode } from '@smt/shared';
import { X } from 'lucide-react';
import { configTemplate } from '@/lib/deploy.js';
import ConfigEditor from './ConfigEditor.js';

/**
 * A new app: its name, then its bastion.yml from a template. Saving the
 * config creates the app on the server (bastionctl validates it first).
 */
export default function NewAppDialog({
  serverId,
  existing,
  proxyMode,
  onCreated,
  onClose,
}: {
  serverId: string;
  /** Apps already on the server: saving a config under one of their names would replace its bastion.yml. */
  existing: string[];
  /** The server's proxy mode: bastionctl refuses a config for the other one. */
  proxyMode: DeployProxyMode;
  onCreated: (app: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [step, setStep] = useState<'name' | 'config'>('name');
  const taken = existing.includes(name);
  const valid = DEPLOY_NAME_PATTERN.test(name) && !taken;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="New app" className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <p className="flex-1 text-lg font-semibold">{step === 'name' ? 'New app' : <>New app <span className="font-mono">{name}</span></>}</p>
          <button onClick={onClose} title="Close" className="text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          {step === 'name' ? (
            <form
              className="space-y-3 text-sm"
              onSubmit={(e) => {
                e.preventDefault();
                if (valid) setStep('config');
              }}
            >
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground">App name</span>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value.trim().toLowerCase())}
                  placeholder="site1"
                  className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
                {taken && <span className="mt-1 block text-xs text-red-600">{name} already exists; edit its config instead</span>}
                {name && !taken && !valid && <span className="mt-1 block text-xs text-red-600">a-z, 0-9 and -, starting with a letter or digit (at most 41)</span>}
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground">First domain</span>
                <input
                  value={domain}
                  onChange={(e) => setDomain(e.target.value.trim().toLowerCase())}
                  placeholder={`${name || 'site1'}.example.com`}
                  className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
                  Cancel
                </button>
                <button type="submit" disabled={!valid} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                  Next
                </button>
              </div>
            </form>
          ) : (
            <ConfigEditor serverId={serverId} app={name} canManage creating initialText={configTemplate(name, domain, proxyMode)} onSaved={() => onCreated(name)} />
          )}
        </div>
      </div>
    </div>
  );
}
