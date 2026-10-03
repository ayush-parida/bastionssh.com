import type { Socket } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { DiagnosticsResult, KubeConnectVia, KubeTestResult } from '@smt/shared';
import { openAgentTunnel } from '../agents/hub.js';
import { getDb } from '../db/index.js';
import { servers } from '../db/schema.js';
import { diagnose } from '../diagnostics/run.js';
import { defaultDeps, type DiagnosticsDeps, type StepOutcome } from '../diagnostics/steps.js';
import { diagnoseServer, type DiagnoseOptions } from '../diagnostics/targets.js';
import { testConnection } from './connection-test.js';
import { apiEndpoint } from './kubeconfig.js';
import { clusterClient, clusterCredential, type ClusterRow } from './service.js';
import type { ApiRoute } from './transport.js';

/**
 * Diagnose for a Kubernetes cluster (spec §12): the usual network steps on
 * the path this app actually takes, then a "Kubernetes API" step — the same
 * checks as "Test connection" (credential, `/version`, what it may do) —
 * when the run includes logging in.
 *
 * - direct: DNS, TCP, TLS (against the cluster CA) and an HTTPS answer from here;
 * - agent: the same over the agent's tunnel to its own loopback;
 * - server: the managed server's own steps (DNS, TCP, SSH banner, host key,
 *   login), since that is the hop this app makes; the API server is then
 *   reached through it in the Kubernetes step.
 */

type Caller = Pick<FastifyRequest, 'orgId' | 'user' | 'role'>;

const REMEDIATION: Record<string, string> = {
  reach: 'Check the API server address and port, and that the route (server or agent) can reach it.',
  tls: "Give the cluster's CA (certificate-authority-data from the kubeconfig) and make sure the URL's host is one the certificate names.",
  auth: 'The token or certificate was refused: it may have expired or been deleted. Create a new service account token (see "Kubernetes" in the README).',
  version: 'The API server did not answer /version; check that the URL points at the API server itself.',
  rules: 'The credential may not review its own permissions; grant it the read-only ClusterRole from the README.',
};

/** A connection test as one diagnostic step. */
export function kubeApiOutcome(result: KubeTestResult): StepOutcome {
  const failed = result.steps.find((s) => s.status === 'fail');
  const data = { serverVersion: result.serverVersion, capabilities: result.capabilities, steps: result.steps };
  if (failed) {
    return { status: 'fail', detail: `${failed.label}: ${failed.detail}`, remediation: REMEDIATION[failed.id], data };
  }
  const warned = result.steps.filter((s) => s.status === 'warn');
  const allowed = result.capabilities?.checks.filter((c) => c.allowed).length ?? 0;
  const total = result.capabilities?.checks.length ?? 0;
  return {
    status: warned.length ? 'warn' : 'ok',
    detail:
      `Kubernetes ${result.serverVersion ?? '(version unknown)'} accepted the stored credential; ` +
      `it may do ${allowed} of ${total} things BastionSSH uses.` +
      (warned.length ? ` ${warned.map((w) => w.detail).join(' ')}` : ''),
    ...(warned.some((w) => w.id === 'rules') && { remediation: REMEDIATION.rules }),
    data,
  };
}

async function kubeApiStep(row: ClusterRow, caller: Caller): Promise<StepOutcome> {
  const route: ApiRoute = {
    orgId: row.orgId,
    apiUrl: row.apiUrl,
    caData: row.caData,
    credential: await clusterCredential(row),
    connectVia: row.connectVia as KubeConnectVia,
    viaServerId: row.viaServerId,
    viaAgentId: row.viaAgentId,
    actorUserId: caller.user.id,
  };
  const client = await clusterClient(row, caller);
  try {
    return kubeApiOutcome(await testConnection({ route, client, namespace: row.defaultNamespace }));
  } finally {
    client.close();
  }
}

/** The network steps over an agent's tunnel: it dials its own loopback. */
function agentDeps(base: DiagnosticsDeps, orgId: string, agentId: string): DiagnosticsDeps {
  return {
    ...base,
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    // A TunnelSocket stands in for a net.Socket (connect, data, end, close, error)
    connect: (_address, port) => openAgentTunnel({ orgId, agentId }, port) as unknown as Socket,
  };
}

export async function diagnoseCluster(row: ClusterRow, caller: Caller, opts: DiagnoseOptions): Promise<DiagnosticsResult> {
  const { host, port } = apiEndpoint(row.apiUrl);
  const target = { kind: 'kube_cluster' as const, id: row.id, name: row.name, host, port, protocol: 'https' };
  const kubeApi = opts.auth ? () => kubeApiStep(row, caller) : undefined;

  if (row.connectVia === 'server' && row.viaServerId) {
    const server = getDb()
      .select()
      .from(servers)
      .where(and(eq(servers.id, row.viaServerId), eq(servers.orgId, row.orgId)))
      .get();
    if (server) {
      // The hop this app makes is the SSH login; Docker is not what is being diagnosed
      const hop = await diagnoseServer({ ...server, dockerMode: 'off' }, row.orgId, { ...opts, auth: true });
      const steps = [...hop.steps];
      if (kubeApi) {
        const failedHop = hop.steps.find((s) => s.status === 'fail');
        const started = Date.now();
        steps.push(
          failedHop
            ? { id: 'kube_api', label: 'Kubernetes API', status: 'skipped', durationMs: 0, detail: `${failedHop.label} failed.` }
            : { id: 'kube_api', label: 'Kubernetes API', ...(await kubeApiStep(row, caller)), durationMs: Date.now() - started },
        );
      }
      const failed = steps.find((s) => s.status === 'fail');
      return { ...hop, target, steps, ok: !failed, failedStep: failed?.id ?? null };
    }
  }

  let deps = opts.deps ?? defaultDeps;
  if (row.connectVia === 'agent' && row.viaAgentId) deps = agentDeps(deps, row.orgId, row.viaAgentId);
  return diagnose(target, { host, port, service: 'https', verifyTls: true, ca: row.caData, kubeApi }, { ...opts, deps });
}
