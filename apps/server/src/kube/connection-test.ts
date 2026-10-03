import type { KubeCredentialCapabilities, KubeCredentialCheck, KubeTestResult, KubeTestStep, KubeTestStepId } from '@smt/shared';
import type { KubeClient } from './client.js';
import { KubeError } from './errors.js';
import { apiEndpoint } from './kubeconfig.js';
import { openRaw, startTls, type ApiRoute } from './transport.js';

/**
 * "Test connection" for a cluster (spec §4.2), one step at a time so a
 * failure says where the path broke: reach the API port over the cluster's
 * route → TLS verified against its CA → the credential accepted → `/version`
 * → a `SelfSubjectRulesReview` summarizing what the credential may do, in
 * the words the UI uses. Never throws: every outcome is a step.
 */

const LABELS: Record<KubeTestStepId, string> = {
  reach: 'Reach the API server',
  tls: 'TLS certificate',
  auth: 'Credential',
  version: 'Kubernetes version',
  rules: 'What the credential may do',
};

interface Rule {
  verbs?: string[];
  apiGroups?: string[];
  resources?: string[];
  resourceNames?: string[];
}

/** The checks shown to the admin, in order: what the views and later actions need. */
const CHECKS: { id: string; label: string; verb: string; group: string; resource: string }[] = [
  { id: 'list-pods', label: 'See pods', verb: 'list', group: '', resource: 'pods' },
  { id: 'watch-pods', label: 'Follow changes live', verb: 'watch', group: '', resource: 'pods' },
  { id: 'list-nodes', label: 'See nodes', verb: 'list', group: '', resource: 'nodes' },
  { id: 'list-deployments', label: 'See deployments', verb: 'list', group: 'apps', resource: 'deployments' },
  { id: 'list-events', label: 'See events', verb: 'list', group: '', resource: 'events' },
  { id: 'pod-logs', label: 'Read pod logs', verb: 'get', group: '', resource: 'pods/log' },
  { id: 'scale', label: 'Scale workloads', verb: 'patch', group: 'apps', resource: 'deployments/scale' },
  { id: 'restart', label: 'Restart and roll back deployments', verb: 'patch', group: 'apps', resource: 'deployments' },
  { id: 'delete-pods', label: 'Delete (restart) pods', verb: 'delete', group: '', resource: 'pods' },
  { id: 'exec', label: 'Open a shell in a pod', verb: 'create', group: '', resource: 'pods/exec' },
  { id: 'cordon', label: 'Cordon nodes', verb: 'patch', group: '', resource: 'nodes' },
  { id: 'list-secrets', label: 'List Secrets (values are never shown)', verb: 'list', group: '', resource: 'secrets' },
  { id: 'impersonate', label: 'Impersonate BastionSSH users', verb: 'impersonate', group: '', resource: 'users' },
];

const matches = (list: string[] | undefined, value: string) => !!list && (list.includes('*') || list.includes(value));

/** Whether any rule allows `verb` on `group/resource` for every name (rules limited to names do not count). */
export function rulesAllow(rules: Rule[], verb: string, group: string, resource: string): boolean {
  const [base, sub] = resource.split('/');
  return rules.some(
    (r) =>
      !r.resourceNames?.length &&
      matches(r.verbs, verb) &&
      matches(r.apiGroups, group) &&
      (matches(r.resources, resource) || (!!sub && matches(r.resources, `${base}/*`)) || (r.resources ?? []).includes('*')),
  );
}

/** The credential's capabilities in `namespace`, from the API server's own review. */
export async function credentialCapabilities(client: KubeClient, namespace: string): Promise<KubeCredentialCapabilities> {
  const review = await client.raw<{ status?: { resourceRules?: Rule[]; incomplete?: boolean } }>(
    '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews',
    {
      method: 'POST',
      body: { apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectRulesReview', spec: { namespace } },
      timeoutMs: 10_000,
    },
  );
  const rules = review.status?.resourceRules ?? [];
  const checks: KubeCredentialCheck[] = CHECKS.map((c) => ({
    id: c.id,
    label: c.label,
    allowed: rulesAllow(rules, c.verb, c.group, c.resource),
  }));
  return { namespace, checks, incomplete: review.status?.incomplete === true };
}

function routeLabel(route: ApiRoute, viaName: string | null): string {
  const { host, port } = apiEndpoint(route.apiUrl);
  switch (route.connectVia) {
    case 'server':
      return `Reached ${host}:${port} through ${viaName ?? 'the server'} (SSH).`;
    case 'agent':
      return `Reached port ${port} through the agent ${viaName ?? ''}`.trim() + '.';
    default:
      return `Reached ${host}:${port} directly.`;
  }
}

export interface TestInput {
  route: ApiRoute;
  client: KubeClient;
  /** For messages: the server or agent the route goes through. */
  viaName?: string | null;
  /** The namespace whose rules are summarized. */
  namespace: string;
}

/** Run the test (see the module comment). */
export async function testConnection(input: TestInput): Promise<KubeTestResult> {
  const steps: KubeTestStep[] = [];
  let blocked: string | null = null;
  let serverVersion: string | null = null;
  let capabilities: KubeCredentialCapabilities | null = null;

  const step = async (id: KubeTestStepId, run: () => Promise<{ status?: KubeTestStep['status']; detail: string }>) => {
    if (blocked) {
      steps.push({ id, label: LABELS[id], status: 'skipped', detail: blocked, durationMs: 0 });
      return;
    }
    const started = Date.now();
    try {
      const { status = 'ok', detail } = await run();
      steps.push({ id, label: LABELS[id], status, detail, durationMs: Date.now() - started });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      steps.push({ id, label: LABELS[id], status: 'fail', detail, durationMs: Date.now() - started });
      blocked = `${LABELS[id]} failed.`;
    }
  };

  const opened: { raw: Awaited<ReturnType<typeof openRaw>> | null } = { raw: null };
  await step('reach', async () => {
    opened.raw = await openRaw(input.route);
    return { detail: routeLabel(input.route, input.viaName ?? null) };
  });
  await step('tls', async () => {
    const secure = await startTls(input.route, opened.raw!);
    const cert = secure.getPeerCertificate();
    const subject = cert?.subject?.CN ? `CN=${cert.subject.CN}` : 'the API server';
    secure.destroy();
    return {
      detail: `${input.route.caData ? 'Verified against the cluster CA' : 'Verified against the system trust store'}: certificate for ${subject}${cert?.valid_to ? `, valid until ${cert.valid_to}` : ''}.`,
    };
  });
  await step('auth', async () => {
    try {
      await input.client.raw('/api', { timeoutMs: 10_000 });
      return { detail: 'The API server accepted the credential.' };
    } catch (err) {
      // Authenticated, but not allowed discovery: unusual, and the views will say what is missing
      if (err instanceof KubeError && err.statusCode === 403) {
        return { status: 'warn', detail: `The credential was accepted, but may not read API discovery: ${err.message}` };
      }
      throw err;
    }
  });
  await step('version', async () => {
    const version = await input.client.version();
    serverVersion = version.gitVersion ?? (version.major ? `v${version.major}.${version.minor ?? ''}` : null);
    return { detail: serverVersion ? `Kubernetes ${serverVersion}${version.platform ? ` (${version.platform})` : ''}.` : 'Version unknown.' };
  });
  await step('rules', async () => {
    capabilities = await credentialCapabilities(input.client, input.namespace);
    const allowed = capabilities.checks.filter((c) => c.allowed).length;
    const canSee = capabilities.checks.find((c) => c.id === 'list-pods')?.allowed;
    return {
      status: canSee ? (capabilities.incomplete ? 'warn' : 'ok') : 'warn',
      detail: canSee
        ? `${allowed} of ${capabilities.checks.length} capabilities in ${input.namespace}${capabilities.incomplete ? ' (the API server says this list may be incomplete)' : ''}.`
        : `The credential may not list pods in ${input.namespace} — the cluster map will be empty. Grant it a read-only role (see the README).`,
    };
  });

  return {
    ok: !steps.some((s) => s.status === 'fail'),
    steps,
    serverVersion,
    capabilities,
    checkedAt: new Date().toISOString(),
  };
}
