import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiagnosticStep, DiagnosticTargetKind, DiagnosticsResult, EgressIpInfo, ResourceType } from '@smt/shared';
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Copy,
  Globe,
  KeyRound,
  Loader2,
  RefreshCw,
  Stethoscope,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { diagnosticsPath, isConnectivityFailure, type DiagnoseTarget } from '@/lib/diagnostics.js';
import { useAccessLevels } from '@/hooks/useAccessLevels.js';
import { useModule } from '@/hooks/useModules.js';

/** The resource type each kind of diagnostics target is, for the caller's level on it. */
const TARGET_TYPES: Record<DiagnosticTargetKind, ResourceType> = {
  server: 'server',
  ftp_connection: 'ftp_connection',
  storage_connection: 'storage_connection',
  kube_cluster: 'cluster',
};

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied');
  } catch {
    toast.message('Select the text to copy it');
  }
}

const STATUS_ICON: Record<DiagnosticStep['status'], React.ReactNode> = {
  ok: <CircleCheck size={16} className="text-emerald-500" />,
  warn: <CircleAlert size={16} className="text-amber-500" />,
  fail: <CircleX size={16} className="text-red-500" />,
  skipped: <CircleDashed size={16} className="text-muted-foreground" />,
};

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function StepRow({ step }: { step: DiagnosticStep }) {
  return (
    <li className="flex gap-3 px-4 py-3">
      <span className="mt-0.5 shrink-0">{STATUS_ICON[step.status]}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className={`text-sm font-medium ${step.status === 'skipped' ? 'text-muted-foreground' : ''}`}>
            {step.label}
          </p>
          {step.status !== 'skipped' && (
            <span className="text-muted-foreground shrink-0 font-mono text-xs">{formatMs(step.durationMs)}</span>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 break-words text-sm">{step.detail}</p>
        {step.remediation && (
          <div
            className={`mt-2 flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
              step.status === 'fail'
                ? 'border-red-500/30 bg-red-500/5'
                : 'border-amber-500/30 bg-amber-500/5'
            }`}
          >
            <p className="flex-1 break-words">{step.remediation}</p>
            <button
              onClick={() => copyText(step.remediation!)}
              title="Copy"
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <Copy size={14} />
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

/** Step list for one run: what passed, what failed and what to change. */
export function DiagnosticsResultPanel({ result }: { result: DiagnosticsResult }) {
  const failed = result.steps.find((s) => s.id === result.failedStep);
  return (
    <div className="space-y-3">
      <div
        className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm ${
          result.ok
            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            : 'bg-red-500/10 text-red-700 dark:text-red-300'
        }`}
      >
        {result.ok ? <CircleCheck size={15} className="mt-0.5 shrink-0" /> : <CircleX size={15} className="mt-0.5 shrink-0" />}
        <p>
          {result.ok
            ? `${result.target.host}:${result.target.port} is reachable.`
            : `Stopped at ${failed?.label ?? 'a step'}.`}{' '}
          <span className="opacity-70">Finished in {formatMs(result.durationMs)}.</span>
        </p>
      </div>
      <ol className="border-border divide-border divide-y rounded-md border">
        {result.steps.map((s) => (
          <StepRow key={s.id} step={s} />
        ))}
      </ol>
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Globe size={12} />
        {result.egressIp ? (
          <>
            Connections leave from <code className="font-mono">{result.egressIp}</code>
            <button onClick={() => copyText(result.egressIp!)} title="Copy" className="hover:text-foreground">
              <Copy size={11} />
            </button>
          </>
        ) : (
          'This app’s public IP is unknown (see Settings).'
        )}
      </p>
    </div>
  );
}

/**
 * Runs diagnostics for `target` as soon as it opens, without logging in;
 * logging in with the stored credentials is a separate, explicit run.
 */
export function DiagnosticsDialog({ target, onClose }: { target: DiagnoseTarget; onClose: () => void }) {
  const qc = useQueryClient();
  const [withAuth, setWithAuth] = useState(false);
  const run = useMutation({
    mutationFn: (auth: boolean) => api.post<DiagnosticsResult>(diagnosticsPath(target), { auth }),
    onSuccess: () => {
      // A run may have learned the egress IP; Settings shows the same one
      qc.invalidateQueries({ queryKey: ['diagnostics-egress-ip'] });
    },
  });
  const { mutate } = run;
  // Once per open — StrictMode mounts effects twice, and each run is rate limited
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate(false);
  }, [mutate]);

  function rerun(auth: boolean) {
    setWithAuth(auth);
    run.mutate(auth);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="diagnostics-title"
        className="border-border bg-card flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border shadow-xl"
      >
        <div className="border-border flex items-center gap-3 border-b px-4 py-3">
          <Stethoscope size={16} className="text-primary shrink-0" />
          <span id="diagnostics-title" className="flex-1 truncate text-sm font-semibold">
            Diagnose {target.name}
          </span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" title="Close">
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {run.isPending ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-sm">
              <Loader2 size={22} className="animate-spin" />
              <p>
                Checking DNS, the port, the protocol{target.kind !== 'storage_connection' ? ' and host key' : ''}
                {withAuth ? ', then logging in' : ''}…
              </p>
              <p className="text-xs">A filtered port takes a few seconds to time out.</p>
            </div>
          ) : run.isError ? (
            <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{run.error.message}</p>
          ) : run.data ? (
            <DiagnosticsResultPanel result={run.data} />
          ) : null}
        </div>
        <div className="border-border flex items-center justify-end gap-2 border-t px-4 py-3">
          <button
            onClick={() => rerun(true)}
            disabled={run.isPending}
            title="Also sign in with the stored credentials"
            className="border-border hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm disabled:opacity-50"
          >
            <KeyRound size={14} /> Test login too
          </button>
          <button
            onClick={() => rerun(false)}
            disabled={run.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            <RefreshCw size={14} /> Run again
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Show a failed connection's error; when it is a timeout, refusal or the like,
 * offer to run diagnostics from the toast.
 */
export function connectionFailedToast(
  message: string,
  target: DiagnoseTarget,
  openDiagnostics: (target: DiagnoseTarget) => void,
) {
  if (!isConnectivityFailure(message)) {
    toast.error(message);
    return;
  }
  toast.error(message, {
    duration: 10_000,
    action: { label: 'Run diagnostics', onClick: () => openDiagnostics(target) },
  });
}

/**
 * "Diagnose" button for a card. Opens its own dialog, or calls `onOpen` when the
 * page already hosts one (to share it with a failed-connection toast).
 * Needs `operate` on the target, like the endpoint (custom roles spec §5).
 */
export function DiagnoseButton({
  target,
  onOpen,
  className,
}: {
  target: DiagnoseTarget;
  onOpen?: (target: DiagnoseTarget) => void;
  className?: string;
}) {
  const access = useAccessLevels(TARGET_TYPES[target.kind]);
  const [open, setOpen] = useState(false);
  if (!access.can(target.id, 'operate')) return null;
  return (
    <>
      <button
        onClick={() => (onOpen ? onOpen(target) : setOpen(true))}
        title="Check DNS, the port, the protocol and the host key step by step"
        className={
          className ??
          'text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium'
        }
      >
        <Stethoscope size={12} /> Diagnose
      </button>
      {open && <DiagnosticsDialog target={target} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Settings: the public address outbound connections leave from. */
export function EgressIpSection() {
  const allowed = useModule('diagnostics', 'operate');
  const qc = useQueryClient();
  const { data, isLoading, isFetching, refetch } = useQuery<EgressIpInfo>({
    queryKey: ['diagnostics-egress-ip'],
    queryFn: () => api.get('/diagnostics/egress-ip'),
    enabled: allowed,
    staleTime: 60_000,
  });
  const refresh = useMutation({
    mutationFn: () => api.get<EgressIpInfo>('/diagnostics/egress-ip?refresh=true'),
    onSuccess: (info) => qc.setQueryData(['diagnostics-egress-ip'], info),
    onError: (err: Error) => toast.error(err.message),
  });
  if (!allowed) return null;

  const ip = data?.ip ?? null;
  const source =
    data?.source === 'configured'
      ? 'Set by SMT_EGRESS_IP.'
      : data?.source === 'lookup'
        ? `Looked up via ${data.service ? new URL(data.service).host : 'an IP echo service'}${data.checkedAt ? ` at ${new Date(data.checkedAt).toLocaleTimeString()}` : ''}.`
        : data?.source === 'disabled'
          ? 'Lookups are turned off (SMT_EGRESS_IP=off).'
          : data?.error
            ? `Could not be determined: ${data.error}`
            : '';

  return (
    <section className="mt-10">
      <h2 className="mb-1 text-lg font-semibold">Outbound IP</h2>
      <p className="text-muted-foreground mb-4 text-sm">
        The public address this app connects to servers from. Allow it in firewalls and cloud security groups.
      </p>
      <div className="border-border bg-card flex items-center gap-3 rounded-lg border px-4 py-3">
        <Globe size={16} className="text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm">{isLoading ? '…' : (data?.ip ?? 'Unknown')}</p>
          {source && <p className="text-muted-foreground text-xs">{source}</p>}
        </div>
        {ip && (
          <button onClick={() => copyText(`${ip}/${ip.includes(':') ? 128 : 32}`)} title="Copy as CIDR" className="text-muted-foreground hover:text-foreground">
            <Copy size={14} />
          </button>
        )}
        {data?.source !== 'configured' && data?.source !== 'disabled' && (
          <button
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending || isFetching}
            title="Look up again"
            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw size={14} className={refresh.isPending ? 'animate-spin' : ''} />
          </button>
        )}
      </div>
      {!isLoading && !data && (
        <button onClick={() => refetch()} className="text-muted-foreground mt-2 text-xs underline">
          Retry
        </button>
      )}
    </section>
  );
}
