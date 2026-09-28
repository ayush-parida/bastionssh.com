import { Client } from 'ssh2';
import type { DiagnosticsResult, FtpProtocol } from '@smt/shared';
import type { ftpConnections, servers, storageConnections } from '../db/schema.js';
import { HostKeyMismatchError, sshConnectConfig, type SshAuth, type SshTarget } from '../ssh/host-keys.js';
import { resolveServerAuth } from '../ssh/credentials.js';
import { assertSafeHost, backendFor, decryptPassword } from '../ftp/index.js';
import { assertSafeEndpoint, ops, resolveConnection } from '../storage/index.js';
import { STEP_TIMEOUTS, type StepOutcome } from './steps.js';
import { diagnose, type RunOptions } from './run.js';
import type { DiagnosticService } from './remediation.js';

/**
 * Diagnostics for each kind of saved endpoint: what to probe, and how to log in
 * with its stored credentials through the same code path a real connection
 * takes. Callers have already checked the caller may use the row.
 */

type ServerRow = typeof servers.$inferSelect;
type FtpConnectionRow = typeof ftpConnections.$inferSelect;
type StorageConnectionRow = typeof storageConnections.$inferSelect;

export interface DiagnoseOptions extends RunOptions {
  /** Also log in with the stored credentials. */
  auth: boolean;
  /** May the caller see a presented host key that differs from the pinned one (admin evidence)? */
  revealHostKey: boolean;
}

/**
 * Open an SSH connection through {@link sshConnectConfig} — host key checked as
 * on every connection — and close it as soon as authentication succeeds.
 */
export function sshAuthCheck(
  target: SshTarget,
  auth: SshAuth,
  timeoutMs: number = STEP_TIMEOUTS.auth,
): Promise<StepOutcome> {
  const method = auth.privateKey ? 'SSH key' : 'password';
  return new Promise((resolve) => {
    const client = new Client();
    const { config, guard } = sshConnectConfig(target, auth, 'diagnostics', { readyTimeout: timeoutMs });
    let settled = false;
    const finish = (outcome: StepOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.end();
      } catch {
        // already torn down
      }
      resolve(outcome);
    };
    const timer = setTimeout(
      () => finish({ status: 'fail', detail: `Authentication did not finish within ${timeoutMs / 1000}s.` }),
      timeoutMs + 1_000,
    );

    client
      .on('ready', () =>
        finish({ status: 'ok', detail: `Logged in as ${target.username} with the stored ${method}.`, data: { method } }),
      )
      .on('error', (raw: Error & { level?: string }) => {
        const err = guard.error(raw);
        if (err instanceof HostKeyMismatchError) {
          return finish({
            status: 'fail',
            detail: 'The connection was refused because the host key changed.',
            remediation: 'An admin must review the new key from the host key panel.',
          });
        }
        if (raw.level === 'client-authentication') {
          return finish({
            status: 'fail',
            detail: `The server rejected the stored ${method} for ${target.username}.`,
            remediation: auth.privateKey
              ? `Check that the key’s public half is in ~${target.username}/.ssh/authorized_keys on the server (with ~/.ssh at 700 and authorized_keys at 600), and that the username is right.`
              : 'Check the username and password, and that the server allows password logins (PasswordAuthentication yes in /etc/ssh/sshd_config).',
            data: { method },
          });
        }
        if (raw.level === 'client-timeout' || /timed out/i.test(err.message)) {
          return finish({ status: 'fail', detail: `The SSH handshake timed out: ${err.message}` });
        }
        finish({ status: 'fail', detail: `Could not log in: ${err.message}` });
      })
      .connect(config);
  });
}

export async function diagnoseServer(server: ServerRow, orgId: string, opts: DiagnoseOptions): Promise<DiagnosticsResult> {
  const host = assertSafeHost(server.host);
  return diagnose(
    { kind: 'server', id: server.id, name: server.name, host, port: server.port, protocol: 'ssh' },
    {
      host,
      port: server.port,
      service: 'ssh',
      verifyTls: true,
      hostKey: { pinned: server.hostKeyFingerprint, revealPresented: opts.revealHostKey },
      ...(opts.auth && {
        authenticate: async (): Promise<StepOutcome> => {
          let auth: SshAuth;
          try {
            ({ auth } = await resolveServerAuth(orgId, server.id));
          } catch (err) {
            return {
              status: 'fail',
              detail: (err as Error).message,
              remediation: 'Give the server an SSH key or password in its settings.',
            };
          }
          return sshAuthCheck(
            { id: server.id, host: server.host, port: server.port, username: server.username },
            auth,
          );
        },
      }),
    },
    opts,
  );
}

const FTP_SERVICE: Record<FtpProtocol, DiagnosticService> = {
  ftp: 'ftp',
  ftps: 'ftps',
  'ftps-implicit': 'ftps-implicit',
  sftp: 'ssh',
};

export async function diagnoseFtp(connection: FtpConnectionRow, opts: DiagnoseOptions): Promise<DiagnosticsResult> {
  const host = assertSafeHost(connection.host);
  const protocol = connection.protocol as FtpProtocol;
  const service = FTP_SERVICE[protocol] ?? 'ftp';
  return diagnose(
    { kind: 'ftp_connection', id: connection.id, name: connection.name, host, port: connection.port, protocol },
    {
      host,
      port: connection.port,
      service,
      verifyTls: connection.verifyTls,
      ...(protocol === 'sftp' && {
        hostKey: { pinned: connection.hostKeyFingerprint, revealPresented: opts.revealHostKey },
      }),
      ...(opts.auth && {
        authenticate: async (): Promise<StepOutcome> => {
          try {
            // The same login and listing as the Test button
            const result = await backendFor(protocol).testConnection(connection, await decryptPassword(connection));
            if (result.ok) {
              return {
                status: 'ok',
                detail: `Logged in as ${connection.username}; ${result.workingDirectory ?? '/'} lists ${result.entryCount ?? 0} entries.`,
              };
            }
            const rejected = /\b530\b|authentication failed|login incorrect|rejected the username/i.test(result.error ?? '');
            return {
              status: 'fail',
              detail: result.error ?? 'Login failed.',
              ...(rejected && {
                remediation: 'Check the username and password on the connection; some hosts also lock an account after repeated failures.',
              }),
            };
          } catch (err) {
            if (err instanceof HostKeyMismatchError) {
              return {
                status: 'fail',
                detail: 'The connection was refused because the host key changed.',
                remediation: 'An admin must review the new key on the connection card.',
              };
            }
            return { status: 'fail', detail: (err as Error).message };
          }
        },
      }),
    },
    opts,
  );
}

/** Where a storage connection sends its requests: its endpoint, or AWS's regional one. */
export function storageEndpoint(connection: Pick<StorageConnectionRow, 'endpoint' | 'region'>): URL {
  const raw = connection.endpoint
    ? assertSafeEndpoint(connection.endpoint)
    : `https://s3.${connection.region.trim() || 'us-east-1'}.amazonaws.com`;
  return new URL(raw);
}

export async function diagnoseStorage(
  connection: StorageConnectionRow,
  orgId: string,
  opts: DiagnoseOptions,
): Promise<DiagnosticsResult> {
  const url = storageEndpoint(connection);
  const service: DiagnosticService = url.protocol === 'https:' ? 'https' : 'http';
  // URL keeps the brackets around an IPv6 literal
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const port = url.port ? Number(url.port) : service === 'https' ? 443 : 80;
  return diagnose(
    { kind: 'storage_connection', id: connection.id, name: connection.name, host, port, protocol: service },
    {
      host,
      port,
      service,
      verifyTls: true,
      ...(opts.auth && {
        authenticate: async (): Promise<StepOutcome> => {
          const { client } = await resolveConnection(orgId, connection.id);
          const result = await ops.testConnection(client);
          if (result.ok) {
            return { status: 'ok', detail: `Signed in with access key ${connection.accessKeyId}; ${result.bucketCount ?? 0} buckets listed.` };
          }
          return {
            status: 'fail',
            detail: result.error ?? 'The request was refused.',
            remediation:
              'Check the access key and secret, the region, and that the key is allowed to list buckets (s3:ListAllMyBuckets).',
          };
        },
      }),
    },
    opts,
  );
}
