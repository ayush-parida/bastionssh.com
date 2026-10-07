import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DeployEnvReveal, DeployServiceConnection } from '@smt/shared';
import { Check, Copy, Eye, EyeOff, Loader2, Plug } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { appPath, deployKeys } from '@/lib/deploy.js';
import { passkeyErrorMessage, withStepUp } from '@/lib/passkeys.js';
import DocsLink from '@/components/docs/DocsLink.js';

export const MASK = '••••••••';

/** `{KEY}` placeholders filled from `values`; ones not revealed shown masked. */
export function fillSecrets(text: string, values: Record<string, string>): string {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, key: string) => values[key] ?? MASK);
}

function CopyButton({ text, label, disabled }: { text: string; label: string; disabled?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={`Copy ${label}`}
      title={disabled ? 'Reveal the password first' : `Copy ${label}`}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
    >
      {done ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
    </button>
  );
}

/**
 * A quick service's Connection panel (services spec §3.3): its name on the
 * private network, ports, the published address and ready-made connection
 * strings. Passwords stay masked; a member who manages the app reveals
 * them with a passkey (the same audited reveal as the Environment tab), and
 * they show only until hidden or the page changes.
 */
export default function ConnectionPanel({ serverId, app, canReveal }: { serverId: string; app: string; canReveal: boolean }) {
  const conn = useQuery<DeployServiceConnection>({
    queryKey: deployKeys.connection(serverId, app),
    queryFn: () => api.get(appPath(serverId, app, '/connection')),
    retry: false,
  });
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState(false);
  useEffect(() => setValues({}), [serverId, app]);

  if (conn.isLoading) return <p className="text-sm text-muted-foreground">Reading connection details…</p>;
  if (conn.error || !conn.data) return <p className="text-sm text-red-600">{conn.error ? (conn.error as Error).message : 'No connection details'}</p>;
  const c = conn.data;
  const revealed = c.secrets.length > 0 && c.secrets.every((k) => values[k] !== undefined);

  const reveal = async () => {
    setRevealing(true);
    try {
      const next: Record<string, string> = {};
      for (const key of c.secrets) {
        const res = await withStepUp(() => api.post<DeployEnvReveal>(appPath(serverId, app, `/env/${encodeURIComponent(key)}/reveal`)));
        next[key] = res.value;
      }
      setValues(next);
    } catch (err) {
      toast.error(passkeyErrorMessage(err));
    } finally {
      setRevealing(false);
    }
  };

  return (
    <section aria-label="Connection" className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Plug size={15} className="text-primary" />
        <h3 className="font-semibold">Connection</h3>
        <DocsLink to={c.docs} className="ml-2 text-xs">
          Connecting from Node.js, Python and Go
        </DocsLink>
        {c.secrets.length > 0 && canReveal && (
          <button
            onClick={() => (revealed ? setValues({}) : void reveal())}
            disabled={revealing}
            className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            {revealing ? <Loader2 size={12} className="animate-spin" /> : revealed ? <EyeOff size={12} /> : <Eye size={12} />}
            {revealed ? 'Hide password' : c.secrets.length === 1 ? 'Reveal password' : 'Reveal passwords'}
          </button>
        )}
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        {c.fields.map((f) => {
          const text = f.secret ? (values[f.secret] ?? MASK) : (f.value ?? '—');
          return (
            <div key={f.label}>
              <dt className="text-xs text-muted-foreground">{f.label}</dt>
              <dd className="flex items-center gap-1 font-mono">
                <span className="break-all">{text}</span>
                <CopyButton text={text} label={f.label} disabled={!!f.secret && values[f.secret] === undefined} />
              </dd>
            </div>
          );
        })}
      </dl>
      {c.strings.length > 0 && (
        <div className="space-y-2">
          {c.strings.map((s) => (
            <div key={s.label} className="space-y-1">
              <p className="text-xs text-muted-foreground">{s.label} — apps on this server</p>
              <div className="flex items-center gap-1 rounded-md bg-muted/60 px-2 py-1 font-mono text-xs">
                <code data-testid="connection-string" className="flex-1 break-all">{fillSecrets(s.internal, values)}</code>
                <CopyButton text={fillSecrets(s.internal, values)} label={s.label} disabled={c.secrets.some((k) => s.internal.includes(`{${k}}`) && values[k] === undefined)} />
              </div>
              {s.published && (
                <>
                  <p className="text-xs text-muted-foreground">{s.label} — {c.published?.scope === 'localhost' ? 'through an SSH tunnel' : 'from outside'}</p>
                  <div className="flex items-center gap-1 rounded-md bg-muted/60 px-2 py-1 font-mono text-xs">
                    <code className="flex-1 break-all">{fillSecrets(s.published, values)}</code>
                    <CopyButton text={fillSecrets(s.published, values)} label={`${s.label} (published)`} disabled={c.secrets.some((k) => s.published!.includes(`{${k}}`) && values[k] === undefined)} />
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {c.published
          ? c.published.scope === 'localhost'
            ? `Published on the server's 127.0.0.1:${c.published.port}. From your machine: ssh -L ${c.published.port}:127.0.0.1:${c.published.port} <user>@<server>, then connect to localhost:${c.published.port}.`
            : `Published on every address of the server, port ${c.published.port}: keep it behind a firewall rule for your addresses.`
          : `Not published: only apps on this server reach it, as ${c.host}:${c.port}.`}{' '}
        Ports: {c.ports.map((p) => `${p.port} (${p.label})`).join(', ')}.
      </p>
      {c.ui && (
        <p className="text-sm">
          {c.ui.label}:{' '}
          {c.ui.urls.map((u) => (
            <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="mr-2 text-primary hover:underline">
              {u}
            </a>
          ))}
        </p>
      )}
      {c.secrets.length > 0 && !canReveal && <p className="text-xs text-muted-foreground">Revealing the password needs manage access to deployments on this server.</p>}
    </section>
  );
}
