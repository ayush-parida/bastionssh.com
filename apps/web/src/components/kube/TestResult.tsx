import type { KubeTestResult, KubeTestStep } from '@smt/shared';
import { Check, CircleAlert, CircleCheck, CircleDashed, CircleX, Minus } from 'lucide-react';
import { cn } from '@/lib/utils.js';

const STEP_ICON: Record<KubeTestStep['status'], React.ReactNode> = {
  ok: <CircleCheck size={15} className="text-emerald-500" />,
  warn: <CircleAlert size={15} className="text-amber-500" />,
  fail: <CircleX size={15} className="text-red-500" />,
  skipped: <CircleDashed size={15} className="text-muted-foreground" />,
};

/**
 * "Test connection", step by step (reach → TLS → credential → version →
 * what the credential may do), then the credential's capabilities as the
 * API server itself answered — so an admin sees before saving whether the
 * map, logs or guided actions will work with it.
 */
export default function TestResult({ result }: { result: KubeTestResult }) {
  const caps = result.capabilities;
  return (
    <div className="space-y-3" data-testid="kube-test-result">
      <div
        className={cn(
          'rounded-md px-3 py-2 text-sm',
          result.ok ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-red-500/10 text-red-700 dark:text-red-300',
        )}
      >
        {result.ok
          ? `Connected${result.serverVersion ? ` to Kubernetes ${result.serverVersion}` : ''}.`
          : `Could not connect: ${result.steps.find((s) => s.status === 'fail')?.label ?? 'a step failed'}.`}
      </div>
      <ol className="divide-y divide-border rounded-md border border-border">
        {result.steps.map((s) => (
          <li key={s.id} className="flex gap-2.5 px-3 py-2">
            <span className="mt-0.5 shrink-0">{STEP_ICON[s.status]}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className={cn('text-sm font-medium', s.status === 'skipped' && 'text-muted-foreground')}>{s.label}</p>
                {s.status !== 'skipped' && <span className="shrink-0 font-mono text-xs text-muted-foreground">{s.durationMs} ms</span>}
              </div>
              <p className="break-words text-xs text-muted-foreground">{s.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      {caps && (
        <div>
          <p className="mb-1.5 text-sm font-medium">
            What this credential can do <span className="font-normal text-muted-foreground">in {caps.namespace}</span>
          </p>
          <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2" data-testid="kube-capabilities">
            {caps.checks.map((c) => (
              <li key={c.id} className={cn('flex items-center gap-1.5 text-xs', !c.allowed && 'text-muted-foreground')}>
                {c.allowed ? <Check size={13} className="shrink-0 text-emerald-500" /> : <Minus size={13} className="shrink-0" />}
                {c.label}
              </li>
            ))}
          </ul>
          {caps.incomplete && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              The cluster says this list may be incomplete (a webhook authorizer decides some requests).
            </p>
          )}
        </div>
      )}
    </div>
  );
}
