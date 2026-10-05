import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  DeployAppStatus,
  DeployCertificate,
  DeployDomainCheck,
  DeployDomainDns,
  DeployDomainsReport,
  DeployNginxApplyResult,
  DeployPortCheck,
  DeployProxyMode,
  DeployTls,
} from '@smt/shared';
import { CheckCircle2, Globe, Loader2, Lock, RefreshCw, TriangleAlert, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { appPath, deployKeys, nginxSyncMessage, when } from '@/lib/deploy.js';
import { cn } from '@/lib/utils.js';

const TLS_TEXT: Record<string, string> = {
  auto: 'Let’s Encrypt, obtained and renewed automatically',
  staging: 'Let’s Encrypt staging (test certificates, not trusted by browsers)',
  internal: 'Caddy’s internal CA (private names)',
};

function tlsText(tls: DeployTls, proxy: DeployProxyMode): string {
  if (typeof tls !== 'string') return `Certificate files: ${tls.cert}, ${tls.key}`;
  if (tls.startsWith('dns:')) return `DNS challenge through ${tls.slice(4)} (token in the server's proxy/.env)`;
  if (proxy === 'nginx' && (tls === 'auto' || tls === 'staging')) return `${TLS_TEXT[tls]}, by certbot on the host`;
  return TLS_TEXT[tls] ?? tls;
}

const OK = 'text-emerald-600 dark:text-emerald-400';
const WARN = 'text-amber-600';
const BAD = 'text-red-600';

const DNS_LABEL: Record<DeployDomainCheck['dns']['status'], { text: string; tone: string }> = {
  ok: { text: 'Points to this server', tone: OK },
  wrong: { text: 'Points elsewhere', tone: WARN },
  missing: { text: 'No DNS record', tone: WARN },
  error: { text: 'DNS lookup failed', tone: BAD },
  skipped: { text: 'Not compared', tone: 'text-muted-foreground' },
};

function certSummary(cert: DeployCertificate): { text: string; tone: string } {
  const expiry = cert.notAfter ? `expires ${when(cert.notAfter)}${cert.daysLeft !== null ? ` (${cert.daysLeft} d)` : ''}` : '';
  switch (cert.state) {
    case 'valid':
      return { text: `${cert.issuer ?? 'Certificate'} · ${expiry}`, tone: OK };
    case 'expiring':
      return { text: `${cert.issuer ?? 'Certificate'} · ${expiry}`, tone: WARN };
    case 'expired':
      return { text: `Expired ${when(cert.notAfter)}`, tone: BAD };
    case 'failing':
      return { text: cert.notAfter ? `Not renewing · ${expiry}` : 'Could not be obtained', tone: BAD };
    case 'missing':
      return { text: 'Not issued yet', tone: 'text-muted-foreground' };
  }
}

function PortRow({ port }: { port: DeployPortCheck }) {
  const open = port.status === 'open';
  return (
    <li className="space-y-0.5 px-3 py-2 text-xs">
      <p className={cn('flex items-center gap-1.5', open ? OK : WARN)}>
        {open ? <CheckCircle2 size={12} /> : <TriangleAlert size={12} />}
        Port {port.port}: {port.status}
        <span className="text-muted-foreground">— {port.detail}</span>
      </p>
      {port.remediation && <p className="text-muted-foreground">{port.remediation}</p>}
    </li>
  );
}

/**
 * The app's domains (spec §6), checked by BastionSSH on request
 * (`GET …/domains`): whether each domain's A/AAAA records point at the
 * server, with the exact records to create when they do not; ports 80 and
 * 443 for ACME certificates; and each certificate's issuer, expiry and last
 * error as the server reports it. Nothing is kept: every visit checks again.
 * Domains are edited in bastion.yml. In nginx mode an operator can run the
 * host's helper again (after fixing DNS, to retry the certificate).
 */
export default function DomainsPanel({
  serverId,
  app,
  status,
  proxyMode,
  canOperate,
  onEdit,
}: {
  serverId: string;
  app: string;
  status: DeployAppStatus;
  proxyMode: DeployProxyMode;
  canOperate: boolean;
  /** Opens the config editor; absent without manage. */
  onEdit?: () => void;
}) {
  const config = status.config;
  const report = useQuery<DeployDomainsReport>({
    queryKey: deployKeys.domains(serverId, app),
    queryFn: () => api.get(appPath(serverId, app, '/domains')),
    enabled: !!config,
    retry: false,
    staleTime: 30_000,
  });
  const reapply = useMutation({
    mutationFn: () => api.post<DeployNginxApplyResult>(appPath(serverId, app, '/proxy')),
    onSuccess: (res) => {
      const problem = nginxSyncMessage(res);
      if (problem) toast.warning(problem);
      else toast.success(res.result === 'unchanged' ? 'nginx was already up to date' : 'nginx updated');
      void report.refetch();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const r = report.data;
  // Before the first answer: the domains alone
  const checks: Array<{ domain: string; dns: DeployDomainDns | null; certificate: DeployCertificate | null }> =
    r?.domains ?? (config?.domains ?? status.domains).map((domain) => ({ domain, dns: null, certificate: null }));
  const proxy = r?.proxy ?? proxyMode;

  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">TLS</dt>
          <dd>{config ? tlsText(config.tls, proxy) : '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">www redirect</dt>
          <dd>{config ? (config.redirect_www === 'none' ? 'None' : config.redirect_www === 'apex' ? 'www → apex' : 'apex → www') : '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Server address</dt>
          <dd className="font-mono">
            {r ? (r.serverAddresses.join(', ') || <span className="font-sans text-muted-foreground">Unknown</span>) : '—'}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-xs text-muted-foreground">
          {r ? `Checked ${when(r.checkedAt)} from BastionSSH.` : 'DNS, ports and certificates are checked when this tab opens.'}
        </p>
        <button
          onClick={() => void report.refetch()}
          disabled={!config || report.isFetching}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm hover:bg-muted disabled:opacity-50"
        >
          {report.isFetching ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Check again
        </button>
        {proxy === 'nginx' && canOperate && status.currentRelease && (
          <button
            onClick={() => reapply.mutate()}
            disabled={reapply.isPending}
            title="Write the app's nginx server block and request its certificate again"
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm hover:bg-muted disabled:opacity-50"
          >
            {reapply.isPending ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />} Apply nginx again
          </button>
        )}
        {onEdit && (
          <button onClick={onEdit} className="rounded-md border border-border px-2.5 py-1 text-sm hover:bg-muted">
            Edit domains
          </button>
        )}
      </div>

      {!config && <p className="text-sm text-muted-foreground">bastion.yml is not valid; fix it to check the domains.</p>}
      {report.error && <p className="whitespace-pre-wrap break-words rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(report.error as Error).message}</p>}
      {r?.addressSource === 'none' && (
        <p className="text-xs text-amber-600">The server’s public address could not be determined, so DNS was not compared. Point each domain at the address visitors reach the server on.</p>
      )}
      {r?.certificatesError && <p className="text-xs text-amber-600">Certificates could not be read from the server: {r.certificatesError}</p>}

      <ul aria-label="Domains" className="divide-y divide-border rounded-md border border-border">
        {checks.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">No domains.</li>}
        {checks.map(({ domain, dns, certificate }) => {
          const label = dns ? DNS_LABEL[dns.status] : null;
          const cert = certificate ? certSummary(certificate) : null;
          return (
            <li key={domain} aria-label={domain} className="space-y-1.5 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {config?.tls === 'internal' || domain.startsWith('*.') ? <Globe size={14} className="text-muted-foreground" /> : <Lock size={14} className="text-muted-foreground" />}
                <a href={`https://${domain.replace(/^\*\./, '')}`} target="_blank" rel="noreferrer" className="font-mono text-sm hover:underline">
                  {domain}
                </a>
                {report.isLoading && <Loader2 size={12} className="animate-spin text-muted-foreground" />}
                {dns && label && (
                  <span className={cn('flex items-center gap-1 text-xs', label.tone)}>
                    {dns.status === 'ok' ? <CheckCircle2 size={12} /> : <TriangleAlert size={12} />} {label.text}
                  </span>
                )}
                {cert && <span className={cn('ml-auto text-xs', cert.tone)}>{cert.text}</span>}
              </div>
              {dns && dns.status !== 'ok' && <p className="text-xs text-muted-foreground">{dns.detail}</p>}
              {dns && dns.records.length > 0 && (
                <table className="text-xs">
                  <tbody className="font-mono">
                    {dns.records.map((rec) => (
                      <tr key={`${rec.type} ${rec.value}`}>
                        <td className="pr-3">{rec.type}</td>
                        <td className="pr-3">{rec.name}</td>
                        <td>{rec.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {certificate?.lastError && certificate.state !== 'valid' && (
                <p className="whitespace-pre-wrap break-words text-xs text-red-600">
                  Last certificate error{certificate.lastError.at ? ` (${when(certificate.lastError.at)})` : ''}: {certificate.lastError.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {r && r.ports.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Ports for the certificate authority</p>
          <ul aria-label="Ports" className="divide-y divide-border rounded-md border border-border">
            {r.ports.map((p) => (
              <PortRow key={p.port} port={p} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
