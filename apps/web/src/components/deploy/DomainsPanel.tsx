import { useState } from 'react';
import type { DeployAppStatus, DeployTls, DnsLookupResult } from '@smt/shared';
import { CheckCircle2, Globe, Loader2, Lock, Radar, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api.js';
import { useVisibleModules } from '@/hooks/useModules.js';
import { when, type DeployAppRow } from '@/lib/deploy.js';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The record that would point `domain` at the server, as a DNS provider asks for it. */
function recordFor(domain: string, host: string): string {
  if (IPV4.test(host)) return `A     ${domain}  →  ${host}`;
  if (host.includes(':')) return `AAAA  ${domain}  →  ${host}`;
  return `A     ${domain}  →  the address of ${host}`;
}

const TLS_TEXT: Record<string, string> = {
  auto: 'Let’s Encrypt, obtained and renewed by Caddy',
  staging: 'Let’s Encrypt staging (test certificates, not trusted by browsers)',
  internal: 'Caddy’s internal CA (private names)',
};

function tlsText(tls: DeployTls): string {
  if (typeof tls !== 'string') return `Certificate files: ${tls.cert}, ${tls.key}`;
  if (tls.startsWith('dns:')) return `DNS challenge through ${tls.slice(4)} (token in the server's proxy/.env)`;
  return TLS_TEXT[tls] ?? tls;
}

type Check = { state: 'checking' } | { state: 'done'; result: DnsLookupResult } | { state: 'error'; error: string };

/**
 * The app's domains (spec §6): TLS mode and certificate status, and a DNS
 * check through the DNS Lookup module — whether the A/AAAA records point at
 * this server, and the record to create when they do not. Domains are edited
 * in bastion.yml.
 */
export default function DomainsPanel({
  serverId,
  host,
  status,
  onEdit,
}: {
  serverId: string;
  /** The server's address, as BastionSSH connects to it. */
  host: string | null;
  status: DeployAppStatus & Pick<DeployAppRow, 'certificate'>;
  /** Opens the config editor; absent without manage. */
  onEdit?: () => void;
}) {
  const { isVisible } = useVisibleModules();
  const canLookup = isVisible('diagnostics');
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const config = status.config;
  const domains = config?.domains ?? status.domains;

  async function check(domain: string) {
    setChecks((c) => ({ ...c, [domain]: { state: 'checking' } }));
    try {
      const result = await api.get<DnsLookupResult>(`/dns/lookup?domain=${encodeURIComponent(domain)}`);
      setChecks((c) => ({ ...c, [domain]: { state: 'done', result } }));
    } catch (err) {
      setChecks((c) => ({ ...c, [domain]: { state: 'error', error: (err as Error).message } }));
    }
  }

  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">TLS</dt>
          <dd>{config ? tlsText(config.tls) : '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">www redirect</dt>
          <dd>{config ? (config.redirect_www === 'none' ? 'None' : config.redirect_www === 'apex' ? 'www → apex' : 'apex → www') : '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Certificate</dt>
          <dd>
            {status.certificate ? (
              status.certificate.error ? (
                <span className="text-red-600">{status.certificate.error}</span>
              ) : (
                <>
                  {status.certificate.issuer ?? 'Unknown issuer'} · expires {when(status.certificate.expiresAt)}
                </>
              )
            ) : (
              <span className="text-muted-foreground">Not reported by the server</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="flex items-center gap-2">
        <p className="flex-1 text-xs text-muted-foreground">
          Every domain needs an A (or AAAA) record pointing at this server{config?.tls === 'auto' ? ', and ports 80 and 443 open, for its certificate' : ''}.
        </p>
        {onEdit && (
          <button onClick={onEdit} className="rounded-md border border-border px-2.5 py-1 text-sm hover:bg-muted">
            Edit domains
          </button>
        )}
      </div>

      <ul aria-label="Domains" className="divide-y divide-border rounded-md border border-border">
        {domains.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">No domains.</li>}
        {domains.map((domain) => {
          const c = checks[domain];
          const addresses =
            c?.state === 'done'
              ? c.result.records.filter((r) => r.type === 'A' || r.type === 'AAAA').flatMap((r) => r.records)
              : [];
          const pointsHere = addresses.some((r) => r.server?.id === serverId || (host !== null && r.value === host));
          return (
            <li key={domain} aria-label={domain} className="space-y-2 px-3 py-2.5">
              <div className="flex items-center gap-2">
                {config?.tls === 'internal' || domain.startsWith('*.') ? <Globe size={14} className="text-muted-foreground" /> : <Lock size={14} className="text-muted-foreground" />}
                <a href={`https://${domain.replace(/^\*\./, '')}`} target="_blank" rel="noreferrer" className="font-mono text-sm hover:underline">
                  {domain}
                </a>
                {c?.state === 'done' &&
                  (pointsHere ? (
                    <span className="flex items-center gap-1 text-xs text-emerald-600">
                      <CheckCircle2 size={12} /> Points to this server
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-amber-600">
                      <TriangleAlert size={12} /> {addresses.length ? 'Points elsewhere' : c.result.notFound ? 'Name does not exist' : 'No address records'}
                    </span>
                  ))}
                {canLookup && !domain.startsWith('*.') && (
                  <button
                    onClick={() => void check(domain)}
                    disabled={c?.state === 'checking'}
                    className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                  >
                    {c?.state === 'checking' ? <Loader2 size={12} className="animate-spin" /> : <Radar size={12} />} Check DNS
                  </button>
                )}
              </div>
              {c?.state === 'error' && <p className="text-xs text-red-600">{c.error}</p>}
              {c?.state === 'done' && (
                <div className="space-y-1 text-xs">
                  {addresses.length > 0 && (
                    <p className="text-muted-foreground">
                      Resolves to <span className="font-mono text-foreground">{addresses.map((a) => a.value).join(', ')}</span>
                      {!c.result.propagation.consistent && ' — resolvers disagree (still propagating?)'}
                    </p>
                  )}
                  {!pointsHere && host && (
                    <p>
                      Create this record at your DNS provider:
                      <span className="mt-1 block whitespace-pre rounded bg-muted px-2 py-1 font-mono">{recordFor(domain, host)}</span>
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
