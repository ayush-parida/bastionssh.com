import { describe, it, expect, vi, beforeEach } from 'vitest';

const broker = vi.hoisted(() => ({
  getSessionForUser: vi.fn(),
  exec: vi.fn(),
  execOnServer: vi.fn(),
}));
const credentials = vi.hoisted(() => ({ resolveServerAuth: vi.fn() }));
const access = vi.hoisted(() => ({ canAccessServer: vi.fn() }));

vi.mock('../ssh/broker.js', () => ({
  SSHBroker: { getSessionForUser: broker.getSessionForUser, exec: broker.exec },
  execOnServer: broker.execOnServer,
}));
vi.mock('../ssh/credentials.js', () => ({ resolveServerAuth: credentials.resolveServerAuth }));
vi.mock('../db/index.js', () => ({ getDb: vi.fn() }));
vi.mock('../auth/server-access.js', () => ({
  canAccessServer: access.canAccessServer,
  accessibleServerFilter: vi.fn(),
}));

import { ToolExecutor } from './tools.js';

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });

/** A live session owned by user-1 in org-1, connected to `serverId`. */
function sessionOn(serverId: string) {
  broker.getSessionForUser.mockImplementation((id: string, userId: string, orgId: string) =>
    id === 'sess-1' && userId === 'user-1' && orgId === 'org-1'
      ? { id, userId, orgId, server: { id: serverId, host: 'h', port: 22, username: 'u' } }
      : undefined,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  access.canAccessServer.mockReturnValue(true);
  broker.exec.mockResolvedValue(ok('via-session'));
  broker.execOnServer.mockResolvedValue(ok('via-direct'));
  credentials.resolveServerAuth.mockImplementation(async (_orgId: string, serverId: string) => ({
    server: { id: serverId, host: `${serverId}.example`, port: 22, username: 'root' },
    auth: { privateKey: 'k' },
  }));
});

describe('ToolExecutor run_command', () => {
  it('refuses a server the member has no access to, even through their session', async () => {
    sessionOn('prod');
    access.canAccessServer.mockImplementation((_who: unknown, id: string) => id !== 'prod');
    const tools = new ToolExecutor('org-1', 'user-1', 'sess-1', 'prod');

    await expect(tools.runCommand({ command: 'uptime' })).rejects.toThrow('Server not found');
    expect(tools.resolveTarget({ command: 'uptime' })).toEqual({});
    expect(broker.exec).not.toHaveBeenCalled();
    expect(broker.execOnServer).not.toHaveBeenCalled();
  });

  it('uses the session when no server_id is given', async () => {
    sessionOn('staging');
    const tools = new ToolExecutor('org-1', 'user-1', 'sess-1', 'staging');

    const out = await tools.execute('run_command', { command: 'uptime' });

    expect(out).toContain('via-session');
    expect(broker.exec).toHaveBeenCalledWith('sess-1', 'uptime', undefined, {
      userId: 'user-1',
      orgId: 'org-1',
    });
    expect(broker.execOnServer).not.toHaveBeenCalled();
  });

  it('runs on the requested server, not the session, when server_id differs', async () => {
    sessionOn('staging');
    const tools = new ToolExecutor('org-1', 'user-1', 'sess-1', 'staging');

    const out = await tools.execute('run_command', { command: 'systemctl restart pg', server_id: 'prod' });

    expect(out).toContain('via-direct');
    expect(broker.exec).not.toHaveBeenCalled();
    expect(credentials.resolveServerAuth).toHaveBeenCalledWith('org-1', 'prod');
    expect(broker.execOnServer).toHaveBeenCalledWith(
      { host: 'prod.example', port: 22, username: 'root' },
      { privateKey: 'k' },
      'systemctl restart pg',
    );
  });

  it('ignores a session that belongs to another user or org', async () => {
    sessionOn('staging');
    const tools = new ToolExecutor('org-2', 'user-2', 'sess-1', 'staging');

    await tools.execute('run_command', { command: 'id' });

    expect(broker.exec).not.toHaveBeenCalled();
    // Falls back to an org-scoped lookup, which rejects servers outside org-2
    expect(credentials.resolveServerAuth).toHaveBeenCalledWith('org-2', 'staging');
  });

  it('targets the session server when neither server_id nor an active server is given', async () => {
    sessionOn('staging');
    const tools = new ToolExecutor('org-1', 'user-1', 'sess-1');

    await tools.execute('run_command', { command: 'df -h' });

    expect(broker.exec).toHaveBeenCalled();
  });

  it('resolves credentials through the org-scoped resolver without a session', async () => {
    credentials.resolveServerAuth.mockRejectedValue(new Error('SSH key not found'));
    const tools = new ToolExecutor('org-1', 'user-1', undefined, 'srv');

    await expect(tools.execute('run_command', { command: 'ls' })).rejects.toThrow('SSH key not found');
    expect(broker.execOnServer).not.toHaveBeenCalled();
  });
});
