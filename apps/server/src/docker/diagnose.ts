import type { StepOutcome } from '../diagnostics/steps.js';
import { resolveServerAuth } from '../ssh/credentials.js';
import { acquire, poolKey } from './pool.js';
import { probeDocker } from './probe.js';
import type { ServerRow } from './service.js';

/**
 * The Docker step of a server's Diagnose run: the same detection as "Detect
 * Docker", over the caller's pooled connection, without recording anything
 * (only an admin's probe, or real use, updates the server row). A missing or
 * unusable Docker is a warning, not a failure: the server itself is fine.
 */
export async function dockerDiagnosticStep(server: ServerRow, orgId: string, actorUserId: string): Promise<StepOutcome> {
  let lease;
  try {
    const { auth } = await resolveServerAuth(orgId, server.id);
    lease = await acquire(
      poolKey(orgId, server.id, actorUserId),
      { id: server.id, host: server.host, port: server.port, username: server.username },
      auth,
      actorUserId,
    );
  } catch (err) {
    return { status: 'warn', detail: `Could not open an SSH connection to check Docker: ${(err as Error).message}` };
  }
  try {
    const result = await probeDocker(lease.client, { override: server.dockerSocketPath, username: server.username });
    if (result.ok) {
      const flavor = result.flavor === 'podman' ? 'Podman' : result.flavor === 'rootless' ? 'Rootless Docker' : 'Docker';
      return {
        status: 'ok',
        detail: `${flavor} ${result.version} answered on ${result.socketPath} (${result.transport}, API ${result.apiVersion}).`,
        data: { transport: result.transport, socketPath: result.socketPath, version: result.version, apiVersion: result.apiVersion },
      };
    }
    return {
      status: 'warn',
      detail: result.error ?? 'Docker was not found.',
      ...(result.hint && { remediation: result.hint }),
      data: { problem: result.problem },
    };
  } finally {
    lease.release();
  }
}
