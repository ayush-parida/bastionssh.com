/** Connectivity diagnostics: why a server, file or storage connection cannot be reached. */

/**
 * `docker` runs for servers with Docker on, after a successful login; its
 * problems are warnings. `kube_api` runs for Kubernetes clusters: credentials,
 * `/version` and what the credential may do, over the cluster's own route.
 */
export type DiagnosticStepId = 'dns' | 'tcp' | 'tls' | 'banner' | 'host_key' | 'auth' | 'docker' | 'kube_api';

/**
 * `skipped` means the step did not run — an earlier step failed, it does not
 * apply to the protocol, or (for `auth`) it was not requested.
 */
export type DiagnosticStepStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface DiagnosticStep {
  id: DiagnosticStepId;
  label: string;
  status: DiagnosticStepStatus;
  /** Wall time the step took; 0 when skipped. */
  durationMs: number;
  /** What was observed, in plain words. */
  detail: string;
  /** What to change to fix it — ready to paste where it is a rule or a command. */
  remediation?: string;
  /** Machine-readable facts behind the detail (addresses, outcome, banner…). */
  data?: Record<string, unknown>;
}

export type DiagnosticTargetKind = 'server' | 'ftp_connection' | 'storage_connection' | 'kube_cluster';

export interface DiagnosticsTarget {
  kind: DiagnosticTargetKind;
  id: string;
  name: string;
  host: string;
  port: number;
  /** ssh, sftp, ftp, ftps, ftps-implicit, http or https. */
  protocol: string;
}

export interface DiagnosticsResult {
  target: DiagnosticsTarget;
  /** True when no step failed. */
  ok: boolean;
  /** The first step that failed, if any. */
  failedStep: DiagnosticStepId | null;
  steps: DiagnosticStep[];
  /** This app's public IP as seen by the internet, when known. */
  egressIp: string | null;
  startedAt: string;
  durationMs: number;
}

export interface DiagnosticsRequest {
  /** Also log in with the stored credentials. Off by default. */
  auth?: boolean;
}

export type EgressIpSource = 'configured' | 'lookup' | 'disabled' | 'unavailable';

/** The public address outbound connections leave from — what a firewall must allow. */
export interface EgressIpInfo {
  ip: string | null;
  /** configured = SMT_EGRESS_IP; lookup = an IP echo service; disabled = lookups turned off. */
  source: EgressIpSource;
  /** The echo service that answered, for `lookup`. */
  service?: string;
  checkedAt: string | null;
  /** Why the lookup failed, for `unavailable`. */
  error?: string;
}
