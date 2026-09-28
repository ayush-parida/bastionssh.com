import { describe, it, expect } from 'vitest';
import type { EgressIpInfo } from '@smt/shared';
import { runDiagnostics, type DiagnosticPlan } from './run.js';
import { FINGERPRINT, codedError, fakeConnect, fakeDeps, fakeTls } from './fakes.test-helper.js';

const egress = (ip: string | null) => async (): Promise<EgressIpInfo> => ({
  ip,
  source: ip ? 'lookup' : 'unavailable',
  checkedAt: new Date().toISOString(),
});

const sshPlan = (overrides: Partial<DiagnosticPlan> = {}): DiagnosticPlan => ({
  host: 'web.example.com',
  port: 22,
  service: 'ssh',
  verifyTls: true,
  hostKey: { pinned: FINGERPRINT, revealPresented: false },
  ...overrides,
});

const statuses = (steps: Array<{ id: string; status: string }>) => steps.map((s) => `${s.id}:${s.status}`);

describe('runDiagnostics', () => {
  it('runs every SSH step in order and skips auth unless asked', async () => {
    const { connect, sockets } = fakeConnect({ kind: 'connect', greeting: 'SSH-2.0-OpenSSH_9.6\r\n' });
    const result = await runDiagnostics(sshPlan(), { deps: fakeDeps({ connect }), egress: egress('49.43.168.212') });
    expect(statuses(result.steps)).toEqual(['dns:ok', 'tcp:ok', 'banner:ok', 'host_key:ok', 'auth:skipped']);
    expect(result.ok).toBe(true);
    expect(result.failedStep).toBeNull();
    expect(result.egressIp).toBe('49.43.168.212');
    for (const step of result.steps) expect(step.durationMs).toBeGreaterThanOrEqual(0);
    // The probe connection is always closed
    expect(sockets.every((s) => s.destroyed)).toBe(true);
  });

  it('stops at NXDOMAIN and skips everything after it', async () => {
    const deps = fakeDeps({
      lookup: () => Promise.reject(codedError('ENOTFOUND')),
      resolve4: () => Promise.reject(codedError('ENOTFOUND')),
    });
    const result = await runDiagnostics(sshPlan({ authenticate: async () => ({ status: 'ok', detail: 'x' }) }), {
      deps,
      egress: egress(null),
    });
    expect(statuses(result.steps)).toEqual(['dns:fail', 'tcp:skipped', 'banner:skipped', 'host_key:skipped', 'auth:skipped']);
    expect(result.failedStep).toBe('dns');
    expect(result.steps[0]!.detail).toContain('NXDOMAIN');
    expect(result.steps[1]!.detail).toBe('DNS resolution failed.');
  });

  it('gives a ready-to-paste firewall rule for a filtered port', async () => {
    const deps = fakeDeps({ connect: fakeConnect({ kind: 'error', code: 'ETIMEDOUT' }).connect });
    const result = await runDiagnostics(sshPlan(), { deps, egress: egress('49.43.168.212') });
    const tcp = result.steps.find((s) => s.id === 'tcp')!;
    expect(tcp.status).toBe('fail');
    expect(tcp.remediation).toContain(
      'Allow inbound TCP 22 from 49.43.168.212/32 (AWS security group: Type SSH, Source 49.43.168.212/32)',
    );
    expect(result.failedStep).toBe('tcp');
  });

  it('points a refused port at the daemon, not the firewall', async () => {
    const deps = fakeDeps({ connect: fakeConnect({ kind: 'error', code: 'ECONNREFUSED' }).connect });
    const result = await runDiagnostics(sshPlan({ port: 2222 }), { deps, egress: egress('49.43.168.212') });
    const tcp = result.steps.find((s) => s.id === 'tcp')!;
    expect(tcp.data?.outcome).toBe('refused');
    expect(tcp.remediation).toContain('listening on port 2222');
    expect(tcp.remediation).not.toContain('49.43.168.212');
  });

  it('reports an unreachable network', async () => {
    const deps = fakeDeps({ connect: fakeConnect({ kind: 'error', code: 'EHOSTUNREACH' }).connect });
    const result = await runDiagnostics(sshPlan({ host: '10.1.2.3' }), { deps, egress: egress(null) });
    const tcp = result.steps.find((s) => s.id === 'tcp')!;
    expect(tcp.data?.outcome).toBe('unreachable');
    expect(tcp.remediation).toContain('private address');
  });

  it('runs authentication only when requested, after the other steps pass', async () => {
    const calls: string[] = [];
    const result = await runDiagnostics(
      sshPlan({
        authenticate: async () => {
          calls.push('auth');
          return { status: 'fail', detail: 'The server rejected the stored SSH key for root.' };
        },
      }),
      { deps: fakeDeps(), egress: egress(null) },
    );
    expect(calls).toEqual(['auth']);
    expect(statuses(result.steps).at(-1)).toBe('auth:fail');
    expect(result.failedStep).toBe('auth');
    expect(result.ok).toBe(false);
  });

  it('does explicit FTPS as greeting, then AUTH TLS and the handshake', async () => {
    const { connect } = fakeConnect({
      kind: 'connect',
      greeting: '220 Welcome\r\n',
      respond: (chunk, socket) => {
        if (chunk.startsWith('AUTH TLS')) socket.send('234 Proceed with negotiation.\r\n');
      },
    });
    const tls = fakeTls({ cert: { authorized: true } });
    const result = await runDiagnostics(
      { host: 'files.example.com', port: 21, service: 'ftps', verifyTls: true },
      { deps: fakeDeps({ connect, tlsConnect: tls.tlsConnect }), egress: egress(null) },
    );
    expect(statuses(result.steps)).toEqual(['dns:ok', 'tcp:ok', 'banner:ok', 'tls:ok', 'auth:skipped']);
    expect(tls.calls[0]!.servername).toBe('files.example.com');
  });

  it('does implicit FTPS as the handshake first, then the greeting over TLS', async () => {
    const { connect } = fakeConnect({ kind: 'connect' });
    const tls = fakeTls({ cert: { authorized: true }, afterHandshake: '220 Secure FTP ready\r\n' });
    const result = await runDiagnostics(
      { host: 'files.example.com', port: 990, service: 'ftps-implicit', verifyTls: true },
      { deps: fakeDeps({ connect, tlsConnect: tls.tlsConnect }), egress: egress(null) },
    );
    expect(statuses(result.steps)).toEqual(['dns:ok', 'tcp:ok', 'tls:ok', 'banner:ok', 'auth:skipped']);
    expect(result.steps.find((s) => s.id === 'banner')!.label).toBe('FTP greeting');
  });

  it('skips the greeting when the TLS handshake fails', async () => {
    const tls = fakeTls({ error: 'wrong version number' });
    const result = await runDiagnostics(
      { host: 'files.example.com', port: 21, service: 'ftps-implicit', verifyTls: true },
      { deps: fakeDeps({ connect: fakeConnect({ kind: 'connect' }).connect, tlsConnect: tls.tlsConnect }), egress: egress(null) },
    );
    expect(statuses(result.steps)).toEqual(['dns:ok', 'tcp:ok', 'tls:fail', 'banner:skipped', 'auth:skipped']);
    expect(result.failedStep).toBe('tls');
  });

  it('still answers when the egress lookup throws', async () => {
    const result = await runDiagnostics(sshPlan(), {
      deps: fakeDeps({ connect: fakeConnect({ kind: 'error', code: 'ETIMEDOUT' }).connect }),
      egress: () => Promise.reject(new Error('offline')),
    });
    expect(result.egressIp).toBeNull();
    expect(result.steps.find((s) => s.id === 'tcp')!.remediation).toContain('SMT_EGRESS_IP');
  });
});
