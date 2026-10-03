import type { Socket } from 'node:net';
import type {
  DiagnosticStep,
  DiagnosticStepId,
  DiagnosticsResult,
  DiagnosticsTarget,
  EgressIpInfo,
} from '@smt/shared';
import logger from '../logger.js';
import { getEgressIp } from './egress.js';
import {
  firewallRemediation,
  refusedRemediation,
  unreachableRemediation,
  type DiagnosticService,
} from './remediation.js';
import {
  STEP_TIMEOUTS,
  StepTimeoutError,
  checkDns,
  checkFtpGreeting,
  checkHostKeyPin,
  checkHttpResponse,
  checkSshBanner,
  checkTcp,
  checkTls,
  defaultDeps,
  pickAddress,
  requestAuthTls,
  withTimeout,
  type DiagnosticsDeps,
  type StepOutcome,
} from './steps.js';

/**
 * Runs the steps in order — DNS, TCP, the protocol's own first words (and TLS
 * where it applies), the host key, authentication only when asked, and then
 * Docker for a server that has it on, or the Kubernetes API for a cluster — each
 * with its own budget and timing. Once a step fails, the ones after it are
 * reported as skipped rather than run against a connection that cannot work.
 */

export interface DiagnosticPlan {
  host: string;
  port: number;
  service: DiagnosticService;
  /** Whether an untrusted TLS certificate fails the connection (FTPS, HTTPS). */
  verifyTls: boolean;
  /** SSH endpoints: the pinned fingerprint, and whether the caller may see a different presented one. */
  hostKey?: { pinned: string | null; pinnedType?: string | null; revealPresented: boolean };
  /** Log in with stored credentials. Undefined when not requested. */
  authenticate?: () => Promise<StepOutcome>;
  /** Servers with Docker on, when logging in was requested: find the daemon. Runs after a successful login. */
  docker?: () => Promise<StepOutcome>;
  /** A pinned CA (PEM) the TLS step verifies against instead of the system store: a Kubernetes cluster's own CA. */
  ca?: string | null;
  /** Kubernetes clusters: the credential, `/version` and what it may do, over the cluster's own route. Runs last. */
  kubeApi?: () => Promise<StepOutcome>;
}

export interface RunOptions {
  deps?: DiagnosticsDeps;
  egress?: () => Promise<EgressIpInfo>;
}

const LABELS: Record<DiagnosticStepId, string> = {
  dns: 'DNS resolution',
  tcp: 'TCP connection',
  tls: 'TLS handshake',
  banner: 'Protocol banner',
  host_key: 'Host key',
  auth: 'Authentication',
  docker: 'Docker',
  kube_api: 'Kubernetes API',
};

const BANNER_LABEL: Record<DiagnosticService, string> = {
  ssh: 'SSH banner',
  ftp: 'FTP greeting',
  ftps: 'FTP greeting',
  'ftps-implicit': 'FTP greeting',
  http: 'HTTP response',
  https: 'HTTP response',
};

async function timed(
  id: DiagnosticStepId,
  label: string,
  run: () => Promise<StepOutcome>,
): Promise<DiagnosticStep> {
  const started = Date.now();
  let outcome: StepOutcome;
  try {
    outcome = await run();
  } catch (err) {
    // Steps report their own failures; this is only a backstop for the unexpected
    logger.warn({ err, step: id }, 'Diagnostic step threw');
    outcome = {
      status: 'fail',
      detail: err instanceof StepTimeoutError ? `The step ${err.message}.` : (err as Error).message,
    };
  }
  return { id, label, durationMs: Date.now() - started, ...outcome };
}

function skipped(id: DiagnosticStepId, label: string, detail: string): DiagnosticStep {
  return { id, label, status: 'skipped', durationMs: 0, detail };
}

export async function runDiagnostics(
  plan: DiagnosticPlan,
  opts: RunOptions = {},
): Promise<Pick<DiagnosticsResult, 'ok' | 'failedStep' | 'steps' | 'egressIp' | 'startedAt' | 'durationMs'>> {
  const deps = opts.deps ?? defaultDeps;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  // Looked up alongside the probes; only a failure's remediation waits for it
  const egress = (opts.egress ?? (() => getEgressIp()))().catch(
    (err): EgressIpInfo => ({ ip: null, source: 'unavailable', checkedAt: null, error: (err as Error).message }),
  );

  const steps: DiagnosticStep[] = [];
  /** Why the remaining steps cannot run, once one has failed. */
  let blocked = null as string | null;
  const sockets: Socket[] = [];
  const bannerLabel = BANNER_LABEL[plan.service];
  const usesTls = plan.service === 'ftps' || plan.service === 'ftps-implicit' || plan.service === 'https';

  const push = (step: DiagnosticStep) => {
    steps.push(step);
    if (step.status === 'fail' && !blocked) blocked = `${step.label} failed.`;
    return step;
  };

  try {
    // ── DNS ──
    let addresses: string[] = [];
    push(
      await timed('dns', LABELS.dns, async () => {
        const result = await checkDns(plan.host, deps);
        addresses = result.addresses;
        return result.outcome;
      }),
    );

    // ── TCP ──
    let socket: Socket | undefined;
    const address = pickAddress(addresses);
    if (blocked || !address) {
      push(skipped('tcp', LABELS.tcp, blocked ?? 'No address to connect to.'));
    } else {
      push(
        await timed('tcp', LABELS.tcp, async () => {
          const result = await checkTcp(address, plan.port, deps);
          if (result.socket) {
            socket = result.socket;
            sockets.push(result.socket);
          }
          const context = { port: plan.port, service: plan.service, targetAddress: address };
          switch (result.kind) {
            case 'filtered':
              return {
                ...result.outcome,
                remediation: firewallRemediation({ ...context, egressIp: (await egress).ip }),
              };
            case 'refused':
              return { ...result.outcome, remediation: refusedRemediation(plan.port, plan.service) };
            case 'unreachable':
              return { ...result.outcome, remediation: unreachableRemediation(address) };
            default:
              return result.outcome;
          }
        }),
      );
    }

    // ── Protocol: banner, and TLS in whichever order the protocol puts them ──
    const tlsStep = async () => {
      if (blocked || !socket) return push(skipped('tls', LABELS.tls, blocked ?? 'Not connected.'));
      const raw = socket;
      return push(
        await timed('tls', LABELS.tls, async () => {
          if (plan.service === 'ftps') {
            const upgrade = await requestAuthTls(raw);
            if (!upgrade.ok) return upgrade.outcome;
          }
          const result = await checkTls(
            { socket: raw, host: plan.host, service: plan.service, verify: plan.verifyTls, ca: plan.ca },
            deps,
          );
          if (result.socket) {
            socket = result.socket;
            sockets.push(result.socket);
          }
          return result.outcome;
        }),
      );
    };
    const bannerStep = async () => {
      if (blocked || !socket) return push(skipped('banner', bannerLabel, blocked ?? 'Not connected.'));
      const current = socket;
      return push(
        await timed('banner', bannerLabel, () => {
          switch (plan.service) {
            case 'ssh':
              return checkSshBanner(current);
            case 'http':
            case 'https': {
              const defaultPort = plan.service === 'https' ? 443 : 80;
              const host = plan.host.includes(':') ? `[${plan.host}]` : plan.host;
              return checkHttpResponse(current, plan.port === defaultPort ? host : `${host}:${plan.port}`);
            }
            default:
              return checkFtpGreeting(current, plan.service === 'ftps-implicit');
          }
        }),
      );
    };

    if (plan.service === 'ftps-implicit' || plan.service === 'https') {
      await tlsStep();
      await bannerStep();
    } else {
      await bannerStep();
      if (usesTls) await tlsStep();
    }

    // The protocol probes are done with their connection; later steps open their own
    for (const s of sockets) s.destroy();

    // ── Host key ──
    if (plan.hostKey) {
      const hostKey = plan.hostKey;
      if (blocked) push(skipped('host_key', LABELS.host_key, blocked));
      else {
        push(
          await timed('host_key', LABELS.host_key, () =>
            checkHostKeyPin({ host: plan.host, port: plan.port, ...hostKey }, deps),
          ),
        );
      }
    }

    // ── Authentication ──
    if (!plan.authenticate) {
      push(skipped('auth', LABELS.auth, 'Not requested — run with authentication to test the stored credentials.'));
    } else if (blocked) {
      push(skipped('auth', LABELS.auth, blocked));
    } else {
      const authenticate = plan.authenticate;
      push(await timed('auth', LABELS.auth, () => withTimeout(authenticate(), STEP_TIMEOUTS.auth + 5_000)));
    }

    // ── Docker ──
    if (plan.docker) {
      const docker = plan.docker;
      if (blocked) push(skipped('docker', LABELS.docker, blocked));
      else push(await timed('docker', LABELS.docker, () => withTimeout(docker(), STEP_TIMEOUTS.docker)));
    }

    // ── Kubernetes API ──
    if (plan.kubeApi) {
      const kubeApi = plan.kubeApi;
      if (blocked) push(skipped('kube_api', LABELS.kube_api, blocked));
      else push(await timed('kube_api', LABELS.kube_api, () => withTimeout(kubeApi(), STEP_TIMEOUTS.kubeApi)));
    }
  } finally {
    for (const s of sockets) s.destroy();
  }

  const failed = steps.find((s) => s.status === 'fail');
  return {
    ok: !failed,
    failedStep: failed?.id ?? null,
    steps,
    egressIp: (await egress).ip,
    startedAt,
    durationMs: Date.now() - started,
  };
}

/** Attach the target description to a run. */
export async function diagnose(
  target: DiagnosticsTarget,
  plan: DiagnosticPlan,
  opts?: RunOptions,
): Promise<DiagnosticsResult> {
  return { target, ...(await runDiagnostics(plan, opts)) };
}
