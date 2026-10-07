import { useMemo, useState } from 'react';
import {
  DEPLOY_NAME_PATTERN,
  SERVICE_CATALOG,
  SERVICE_CATEGORIES,
  defaultServiceVersion,
  type DeployProxyMode,
  type ServiceCategory,
  type ServiceTemplate,
} from '@smt/shared';
import { ArrowLeft, Globe, Search, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import { deployPath } from '@/lib/deploy.js';
import { SERVICE_DOCS, serviceDocs } from '@/lib/services.js';
import { cn } from '@/lib/utils.js';
import DocsLink from '@/components/docs/DocsLink.js';
import { DeployRunPanel, useDeployRun } from './DeployRun.js';
import ServiceIcon from './ServiceIcon.js';

const input = 'mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary';
const MEMORY = /^([1-9]\d{0,5})([mg])$/;
const mib = (m: string) => {
  const x = MEMORY.exec(m);
  return x ? Number(x[1]) * (x[2] === 'g' ? 1024 : 1) : NaN;
};

/** A free name for a new service of `t`: its id, then `-2`, `-3`… */
function freeName(t: ServiceTemplate, existing: string[]): string {
  if (!existing.includes(t.id)) return t.id;
  for (let n = 2; ; n++) if (!existing.includes(`${t.id}-${n}`)) return `${t.id}-${n}`;
}

/** The host port offered for publishing: the service's own port moved up by 10000 (5432 → 15432), so a host's own server keeps its port. */
const suggestedPort = (t: ServiceTemplate) => (t.publishPort + 10_000 <= 65_535 ? t.publishPort + 10_000 : t.publishPort);

function Catalog({ onPick }: { onPick: (t: ServiceTemplate) => void }) {
  const [category, setCategory] = useState<ServiceCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = SERVICE_CATALOG.filter(
    (t) =>
      (category === 'all' || t.category === category) &&
      terms.every((term) => `${t.name} ${t.id} ${t.description} ${t.category}`.toLowerCase().includes(term)),
  );
  const counts = useMemo(() => new Map(SERVICE_CATEGORIES.map((c) => [c.id, SERVICE_CATALOG.filter((t) => t.category === c.id).length])), []);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex-1 min-w-[12rem]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            autoFocus
            aria-label="Search services"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search: postgres, cache, s3…"
            className="w-full rounded-md border border-input bg-background py-1.5 pl-8 pr-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </label>
      </div>
      <div role="tablist" aria-label="Categories" className="flex flex-wrap gap-1.5">
        {[{ id: 'all' as const, label: 'All' }, ...SERVICE_CATEGORIES.filter((c) => (counts.get(c.id) ?? 0) > 0)].map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={category === c.id}
            onClick={() => setCategory(c.id)}
            className={cn('rounded-full border px-2.5 py-0.5 text-xs', category === c.id ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}
          >
            {c.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No service matches “{query}”.</p>
      ) : (
        <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => onPick(t)}
                aria-label={t.name}
                className="flex h-full w-full flex-col gap-1.5 rounded-lg border border-border p-3 text-left transition-colors hover:border-primary/60 hover:bg-muted/40"
              >
                <span className="flex items-center gap-2">
                  <span className="rounded-md bg-primary/10 p-1.5 text-primary">
                    <ServiceIcon icon={t.icon} size={15} />
                  </span>
                  <span className="font-medium">{t.name}</span>
                  {t.imageNote && (
                    <span title={t.imageNote} className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                      Community image
                    </span>
                  )}
                  {t.ui?.domain && (
                    <span title={`${t.ui.label} on a domain`} className="ml-auto text-muted-foreground">
                      <Globe size={13} />
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{t.description}</span>
                <span className="mt-auto text-[11px] text-muted-foreground">{t.versions.map((v) => v.major).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Deployments → New service (services spec §3.3): the catalog (categories,
 * search), then the form — name, version, memory, publish (none, localhost
 * for SSH tunnels, or public with a warning) and a domain for services with
 * a web UI — then the server creates it (secrets generated there) and
 * deploys it, the log following here.
 */
export default function ServiceCatalogDialog({
  serverId,
  existing,
  proxyMode,
  onOpen,
  onClose,
}: {
  serverId: string;
  existing: string[];
  proxyMode: DeployProxyMode;
  /** Go to the service's page. */
  onOpen: (name: string) => void;
  onClose: () => void;
}) {
  const [template, setTemplate] = useState<ServiceTemplate | null>(null);
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [memory, setMemory] = useState('');
  const [scope, setScope] = useState<'none' | 'localhost' | 'public'>('none');
  const [port, setPort] = useState('');
  const [domain, setDomain] = useState('');
  const [tls, setTls] = useState<'auto' | 'staging' | 'internal'>('auto');
  const [started, setStarted] = useState<string | null>(null);
  // The create stream is the server's, not an app's: no app name to key the run on
  const run = useDeployRun(serverId, '');

  const pick = (t: ServiceTemplate) => {
    setTemplate(t);
    setName(freeName(t, existing));
    setVersion(defaultServiceVersion(t).major);
    setMemory(t.memory);
    setScope('none');
    setPort(String(suggestedPort(t)));
    setDomain('');
    setTls('auto');
  };

  const nameError = !name ? 'Required' : !DEPLOY_NAME_PATTERN.test(name) ? 'a-z, 0-9 and -, starting with a letter or digit (at most 41)' : existing.includes(name) ? `${name} exists on this server already` : null;
  const memoryError = !template ? null : !MEMORY.test(memory) ? 'Like 512m or 1g' : mib(memory) < mib(template.minMemory) ? `At least ${template.minMemory}` : null;
  const portNumber = Number(port);
  const portError = scope === 'none' ? null : !/^\d{4,5}$/.test(port) || portNumber < 1024 || portNumber > 65535 ? 'A port from 1024 to 65535' : null;
  const domainError = domain && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/.test(domain) ? 'A domain like admin.example.com' : null;
  const valid = !!template && !nameError && !memoryError && !portError && !domainError;

  const create = () => {
    if (!template || !valid) return;
    setStarted(name);
    const body = {
      name,
      template: template.id,
      version,
      memory,
      publish: scope === 'none' ? { scope } : { scope, port: portNumber },
      ...(domain && { domain, tls }),
    };
    void run.follow('create', name, deployPath(serverId, '/services'), body);
  };

  const running = started !== null && run.state.phase !== 'idle';
  // The service exists once the server streamed anything (the deploy may still have failed)
  const created = running && (run.state.lines.length > 0 || run.state.outcome !== null);
  const selectedVersion = template?.versions.find((v) => v.major === version);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={(e) => e.target === e.currentTarget && !run.busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="New service" className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          {template && !running && (
            <button onClick={() => setTemplate(null)} title="Back to the catalog" className="text-muted-foreground hover:text-foreground">
              <ArrowLeft size={16} />
            </button>
          )}
          {template && <ServiceIcon icon={template.icon} className="text-primary" />}
          <p className="flex-1 text-lg font-semibold">{template ? `New ${template.name} service` : 'New service'}</p>
          <DocsLink to={template ? serviceDocs(template.docs) : SERVICE_DOCS.overview} className="text-sm">
            {template ? `${template.name} docs` : 'About services'}
          </DocsLink>
          <button onClick={onClose} disabled={run.busy} title="Close" className="text-muted-foreground hover:text-foreground disabled:opacity-40">
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          {!template ? (
            <Catalog onPick={pick} />
          ) : running ? (
            <div className="space-y-3">
              <DeployRunPanel state={run.state} onDismiss={() => (run.busy ? undefined : setStarted(null))} />
              {!run.busy && (
                <div className="flex justify-end gap-2">
                  {!created && (
                    <button onClick={() => setStarted(null)} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
                      Back to the form
                    </button>
                  )}
                  {created && (
                    <button onClick={() => onOpen(started!)} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">
                      Open {started}
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <form
              className="grid gap-4 text-sm md:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                create();
              }}
            >
              <p className="text-muted-foreground md:col-span-2">{template.description}</p>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground">Name</span>
                <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} className={`${input} font-mono`} />
                <span className={cn('mt-1 block text-xs', nameError ? 'text-red-600' : 'text-muted-foreground')}>
                  {nameError ?? <>Apps on this server reach it as <span className="font-mono">{name}:{template.publishPort}</span></>}
                </span>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground">Version</span>
                <select aria-label="Version" value={version} onChange={(e) => setVersion(e.target.value)} className={input}>
                  {template.versions.map((v) => (
                    <option key={v.major} value={v.major}>
                      {v.label} ({v.version}){v.note ? ` — ${v.note}` : ''}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block break-all font-mono text-[11px] text-muted-foreground">{selectedVersion?.image}</span>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground">Memory limit</span>
                <input aria-label="Memory" value={memory} onChange={(e) => setMemory(e.target.value.trim().toLowerCase())} className={`${input} font-mono`} />
                <span className={cn('mt-1 block text-xs', memoryError ? 'text-red-600' : 'text-muted-foreground')}>{memoryError ?? `Like 512m or 2g; at least ${template.minMemory}`}</span>
              </label>
              <fieldset className="block">
                <legend className="text-xs font-medium text-muted-foreground">Reachable from</legend>
                <div className="mt-1 space-y-1">
                  {(
                    [
                      ['none', 'Apps on this server only', 'The safe default: nothing listens on the host.'],
                      ['localhost', 'This server’s localhost', 'For an SSH tunnel from your machine.'],
                      ['public', 'The internet', 'Every address of the server.'],
                    ] as const
                  ).map(([value, label, hint]) => (
                    <label key={value} className="flex items-start gap-2">
                      <input type="radio" name="publish" value={value} checked={scope === value} onChange={() => setScope(value)} className="mt-0.5" />
                      <span>
                        {label} <span className="text-xs text-muted-foreground">— {hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {scope !== 'none' && (
                  <label className="mt-2 block">
                    <span className="text-xs font-medium text-muted-foreground">Host port (to {template.ports.find((p) => p.port === template.publishPort)?.label ?? template.publishPort})</span>
                    <input aria-label="Host port" value={port} onChange={(e) => setPort(e.target.value.trim())} className={`${input} font-mono`} />
                    {portError && <span className="mt-1 block text-xs text-red-600">{portError}</span>}
                  </label>
                )}
              </fieldset>
              {scope === 'public' && (
                <p role="alert" className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-400 md:col-span-2">
                  <ShieldAlert size={15} className="mt-0.5 shrink-0" />
                  <span>
                    Anyone on the internet can try to connect to {template.name} on port {port || '…'}, with only its password in the way. Prefer localhost and an SSH
                    tunnel; if it must be public, allow only your addresses in the server’s firewall. <DocsLink to={SERVICE_DOCS.exposing}>How to</DocsLink>
                  </span>
                </p>
              )}
              {template.ui?.domain && (
                <div className="grid gap-4 md:col-span-2 md:grid-cols-2">
                  <label className="block">
                    <span className="text-xs font-medium text-muted-foreground">Domain for the {template.ui.label} (optional)</span>
                    <input aria-label="Domain" value={domain} onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} placeholder={`${template.id}.example.com`} className={`${input} font-mono`} />
                    <span className={cn('mt-1 block text-xs', domainError ? 'text-red-600' : 'text-muted-foreground')}>
                      {domainError ?? 'Served through the proxy with HTTPS. Point its DNS at this server first.'}
                    </span>
                  </label>
                  {domain && (
                    <label className="block">
                      <span className="text-xs font-medium text-muted-foreground">Certificate</span>
                      <select aria-label="Certificate" value={tls} onChange={(e) => setTls(e.target.value as typeof tls)} className={input}>
                        <option value="auto">Let’s Encrypt</option>
                        <option value="staging">Let’s Encrypt staging (testing)</option>
                        {proxyMode === 'caddy' && <option value="internal">Caddy’s own CA (internal names)</option>}
                      </select>
                    </label>
                  )}
                </div>
              )}
              {(template.warning || template.imageNote) && (
                <div className="space-y-2 md:col-span-2">
                  {template.warning && (
                    <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-amber-700 dark:text-amber-400">
                      <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                      {template.warning}
                    </p>
                  )}
                  {template.imageNote && (
                    <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      <ShieldAlert size={14} className="mt-0.5 shrink-0" />
                      <span>
                        <span className="font-medium text-foreground">Community-built image.</span> {template.imageNote}
                      </span>
                    </p>
                  )}
                </div>
              )}
              <p className="text-xs text-muted-foreground md:col-span-2">
                {template.secrets.length > 0
                  ? `${template.secrets.map((s) => s.key).join(', ')} ${template.secrets.length === 1 ? 'is' : 'are'} generated on the server and never sent to BastionSSH; reveal ${template.secrets.length === 1 ? 'it' : 'them'} later with your passkey.`
                  : 'Nothing secret is generated for it.'}{' '}
                {template.volumes.length > 0 && 'Its data lives in a Docker volume that stays when the container is replaced.'}
              </p>
              <div className="flex justify-end gap-2 md:col-span-2">
                <button type="button" onClick={() => setTemplate(null)} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
                  Back
                </button>
                <button type="submit" disabled={!valid} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                  Create {template.name}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
