import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '@/lib/api.js';
import type { DnsLookupResult, DnsRecordSet, DnsResolverAnswer } from '@smt/shared';
import { CircleAlert, CircleCheck, Globe, Search, Server as ServerIcon } from 'lucide-react';

const inputClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

/** What each record type is for, so the page reads as an answer and not a dump. */
const TYPE_HINT: Record<string, string> = {
  A: 'IPv4 address',
  AAAA: 'IPv6 address',
  CNAME: 'Alias to another name',
  MX: 'Mail servers, lowest preference first',
  NS: 'Authoritative nameservers',
  TXT: 'Verification, SPF and other text',
  SOA: 'Zone authority and serial',
  CAA: 'Who may issue certificates',
};

function formatTtl(seconds?: number): string | null {
  if (seconds === undefined) return null;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function RecordCard({ set }: { set: DnsRecordSet }) {
  return (
    <div className="border-border bg-card rounded-lg border p-4">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="font-mono text-sm font-semibold">{set.type}</h3>
        <span className="text-muted-foreground text-xs">{TYPE_HINT[set.type]}</span>
      </div>
      {set.error ? (
        <p className="text-xs text-red-500">{set.error}</p>
      ) : set.records.length === 0 ? (
        <p className="text-muted-foreground text-xs">No records</p>
      ) : (
        <ul className="space-y-1.5">
          {set.records.map((record, i) => (
            <li key={`${record.value}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
              {record.priority !== undefined && (
                <span className="text-muted-foreground font-mono text-xs">{record.priority}</span>
              )}
              <span className="break-all font-mono text-sm">{record.value}</span>
              {record.server && (
                <Link
                  to={`/servers/${record.server.id}/health`}
                  className="bg-primary/10 text-primary hover:bg-primary/20 flex items-center gap-1 rounded px-1.5 py-0.5 text-xs"
                  title="This address is a server you manage"
                >
                  <ServerIcon size={10} /> {record.server.name}
                </Link>
              )}
              {formatTtl(record.ttl) && (
                <span className="text-muted-foreground text-xs">TTL {formatTtl(record.ttl)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PropagationRow({ answer }: { answer: DnsResolverAnswer }) {
  return (
    <tr className="border-border border-t">
      <td className="py-2 pr-3">
        <span className="text-sm">{answer.name}</span>
        {answer.authoritative && (
          <span className="bg-muted text-muted-foreground ml-2 rounded px-1.5 py-0.5 text-xs">
            authoritative
          </span>
        )}
      </td>
      <td className="text-muted-foreground py-2 pr-3 font-mono text-xs">{answer.address}</td>
      <td className="py-2 pr-3 font-mono text-sm">
        {answer.error ? (
          <span className="text-muted-foreground">{answer.error}</span>
        ) : answer.addresses.length === 0 ? (
          <span className="text-muted-foreground">no answer</span>
        ) : (
          answer.addresses.join(', ')
        )}
      </td>
      <td className="py-2">
        {!answer.error && answer.addresses.length > 0 && !answer.agrees && (
          <span className="flex items-center gap-1 text-xs text-amber-600">
            <CircleAlert size={11} /> differs
          </span>
        )}
      </td>
    </tr>
  );
}

export default function DnsLookupPage() {
  const [input, setInput] = useState('');
  const [domain, setDomain] = useState('');

  const { data, isFetching, error } = useQuery<DnsLookupResult>({
    queryKey: ['dns-lookup', domain],
    queryFn: () => api.get(`/dns/lookup?domain=${encodeURIComponent(domain)}`),
    enabled: domain !== '',
    retry: false,
    staleTime: 30_000,
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setDomain(input.trim());
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">DNS Lookup</h1>
        <p className="text-muted-foreground text-sm">
          Records and nameservers for a domain, with the servers you manage picked out
        </p>
      </div>

      <form onSubmit={handleSubmit} className="mb-6 flex max-w-xl gap-2">
        <input
          type="text"
          required
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="example.com"
          className={`${inputClass} font-mono`}
        />
        <button
          type="submit"
          disabled={isFetching}
          className="bg-primary text-primary-foreground hover:bg-primary/90 flex shrink-0 items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          <Search size={15} /> {isFetching ? 'Looking up…' : 'Look up'}
        </button>
      </form>

      {error && (
        <p className="mb-6 flex items-center gap-1.5 text-sm text-red-500">
          <CircleAlert size={14} />
          {error instanceof ApiError ? error.message : 'Lookup failed'}
        </p>
      )}

      {!domain && !error && (
        <div className="text-muted-foreground flex flex-col items-center justify-center py-16">
          <Globe size={40} className="mb-3 opacity-30" />
          <p>Enter a domain to see its records, nameservers and propagation.</p>
        </div>
      )}

      {data && (
        <div className="space-y-6">
          <div className="text-muted-foreground flex flex-wrap items-baseline gap-x-3 text-xs">
            <span className="text-foreground font-mono text-sm">{data.domain}</span>
            {data.input && <span>entered as {data.input}</span>}
            <span>{new Date(data.queriedAt).toLocaleString()}</span>
            <span>{data.durationMs} ms</span>
          </div>

          <section>
            <h2 className="mb-2 text-lg font-semibold">Nameservers</h2>
            <div className="border-border bg-card overflow-hidden rounded-lg border">
              {data.nameservers.length === 0 ? (
                <p className="text-muted-foreground px-4 py-6 text-sm">
                  No nameservers answered. The domain may not be registered or delegated.
                </p>
              ) : (
                <div className="divide-border divide-y">
                  {data.nameservers.map((ns) => (
                    <div key={ns.host} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2.5">
                      <span className="font-mono text-sm">{ns.host}</span>
                      <span className="text-muted-foreground font-mono text-xs">
                        {ns.error ?? ns.addresses.join(', ') ?? ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {data.propagation.answers.length > 0 && (
            <section>
              <div className="mb-2 flex items-baseline gap-3">
                <h2 className="text-lg font-semibold">Propagation</h2>
                {data.propagation.consistent ? (
                  <span className="flex items-center gap-1 text-xs text-emerald-500">
                    <CircleCheck size={12} /> every resolver agrees
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-amber-600">
                    <CircleAlert size={12} /> resolvers disagree, a change may still be spreading
                  </span>
                )}
              </div>
              <div className="border-border bg-card overflow-x-auto rounded-lg border px-4 py-1">
                <table className="w-full min-w-[32rem] text-left">
                  <thead>
                    <tr className="text-muted-foreground text-xs">
                      <th className="py-2 pr-3 font-medium">Resolver</th>
                      <th className="py-2 pr-3 font-medium">Queried</th>
                      <th className="py-2 pr-3 font-medium">A records</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.propagation.answers.map((answer) => (
                      <PropagationRow key={`${answer.name}-${answer.address}`} answer={answer} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section>
            <h2 className="mb-2 text-lg font-semibold">Records</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {data.records.map((set) => (
                <RecordCard key={set.type} set={set} />
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
