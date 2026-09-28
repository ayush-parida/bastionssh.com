import { describe, it, expect } from 'vitest';
import {
  checkDns,
  checkFtpGreeting,
  checkHostKeyPin,
  checkHttpResponse,
  checkSshBanner,
  checkTcp,
  checkTls,
  daysUntil,
  parseFtpReply,
  pickAddress,
  requestAuthTls,
} from './steps.js';
import {
  FINGERPRINT,
  FakeSocket,
  OTHER_FINGERPRINT,
  codedError,
  fakeConnect,
  fakeDeps,
  fakeTls,
} from './fakes.test-helper.js';

const never = () => new Promise<never>(() => {});

describe('checkDns', () => {
  it('needs no lookup for an IP address', async () => {
    const deps = fakeDeps({ lookup: () => Promise.reject(new Error('must not be called')) });
    const result = await checkDns('203.0.113.7', deps);
    expect(result.outcome.status).toBe('ok');
    expect(result.addresses).toEqual(['203.0.113.7']);
  });

  it('reports A and AAAA records', async () => {
    const deps = fakeDeps({
      lookup: async () => [
        { address: '2001:db8::5', family: 6 },
        { address: '203.0.113.5', family: 4 },
      ],
    });
    const result = await checkDns('web.example.com', deps);
    expect(result.outcome.status).toBe('ok');
    expect(result.outcome.detail).toContain('203.0.113.5 (A)');
    expect(result.outcome.detail).toContain('2001:db8::5 (AAAA)');
    expect(result.outcome.data).toEqual({ a: ['203.0.113.5'], aaaa: ['2001:db8::5'] });
    // IPv4 is listed first, so it is what TCP tries
    expect(pickAddress(result.addresses)).toBe('203.0.113.5');
  });

  it('warns when a name only has an IPv6 address', async () => {
    const deps = fakeDeps({ lookup: async () => [{ address: '2001:db8::5', family: 6 }] });
    const result = await checkDns('v6.example.com', deps);
    expect(result.outcome.status).toBe('warn');
    expect(result.outcome.remediation).toContain('A record');
  });

  it('says NXDOMAIN clearly when the name does not exist', async () => {
    const deps = fakeDeps({
      lookup: () => Promise.reject(codedError('ENOTFOUND')),
      resolve4: () => Promise.reject(codedError('ENOTFOUND')),
    });
    const result = await checkDns('typo.example.com', deps);
    expect(result.outcome.status).toBe('fail');
    expect(result.outcome.detail).toBe('NXDOMAIN: typo.example.com does not exist in DNS.');
    expect(result.outcome.remediation).toContain('Check the spelling');
    expect(result.addresses).toEqual([]);
  });

  it('tells a name without an address record from one that does not exist', async () => {
    const deps = fakeDeps({
      lookup: () => Promise.reject(codedError('ENOTFOUND')),
      resolve4: () => Promise.reject(codedError('ENODATA')),
    });
    const result = await checkDns('mx-only.example.com', deps);
    expect(result.outcome.status).toBe('fail');
    expect(result.outcome.detail).toContain('exists in DNS but has no A or AAAA record');
  });

  it('reports an unreachable resolver as a temporary failure', async () => {
    const deps = fakeDeps({ lookup: () => Promise.reject(codedError('EAI_AGAIN')) });
    const result = await checkDns('web.example.com', deps);
    expect(result.outcome.status).toBe('fail');
    expect(result.outcome.detail).toContain('failed temporarily (EAI_AGAIN)');
    expect(result.outcome.remediation).toContain('resolv.conf');
  });

  it('times out a lookup that never answers', async () => {
    const deps = fakeDeps({ lookup: never });
    const result = await checkDns('slow.example.com', deps, 20);
    expect(result.outcome.status).toBe('fail');
    expect(result.outcome.detail).toContain('did not answer in time');
  });

  it('refuses a name that resolves to the cloud metadata service', async () => {
    const deps = fakeDeps({ lookup: async () => [{ address: '169.254.169.254', family: 4 }] });
    const result = await checkDns('sneaky.example.com', deps);
    expect(result.outcome.status).toBe('fail');
    expect(result.addresses).toEqual([]);
  });
});

describe('checkTcp', () => {
  it('connects and hands the socket on', async () => {
    const { connect } = fakeConnect({ kind: 'connect' });
    const result = await checkTcp('203.0.113.10', 22, fakeDeps({ connect }));
    expect(result.kind).toBe('connected');
    expect(result.outcome.status).toBe('ok');
    expect(result.socket).toBeDefined();
  });

  it('distinguishes a refused port', async () => {
    const { connect, sockets } = fakeConnect({ kind: 'error', code: 'ECONNREFUSED' });
    const result = await checkTcp('203.0.113.10', 22, fakeDeps({ connect }));
    expect(result.kind).toBe('refused');
    expect(result.outcome.detail).toContain('Connection refused');
    expect(result.outcome.data).toMatchObject({ outcome: 'refused', code: 'ECONNREFUSED' });
    expect(sockets[0]!.destroyed).toBe(true);
  });

  it('treats silence as a filtered port', async () => {
    const { connect, sockets } = fakeConnect({ kind: 'hang' });
    const result = await checkTcp('203.0.113.10', 22, fakeDeps({ connect }), 20);
    expect(result.kind).toBe('filtered');
    expect(result.outcome.detail).toContain('packets are being dropped');
    expect(sockets[0]!.destroyed).toBe(true);
  });

  it('treats the kernel’s ETIMEDOUT as filtered too', async () => {
    const { connect } = fakeConnect({ kind: 'error', code: 'ETIMEDOUT' });
    const result = await checkTcp('203.0.113.10', 22, fakeDeps({ connect }));
    expect(result.kind).toBe('filtered');
  });

  it.each(['EHOSTUNREACH', 'ENETUNREACH'])('reports %s as unreachable', async (code) => {
    const { connect } = fakeConnect({ kind: 'error', code });
    const result = await checkTcp('10.9.8.7', 22, fakeDeps({ connect }));
    expect(result.kind).toBe('unreachable');
    expect(result.outcome.detail).toContain('no route');
  });

  it('reports anything else as a plain error', async () => {
    const { connect } = fakeConnect({ kind: 'error', code: 'ECONNRESET' });
    const result = await checkTcp('203.0.113.10', 22, fakeDeps({ connect }));
    expect(result.kind).toBe('error');
    expect(result.outcome.status).toBe('fail');
  });

  it('brackets an IPv6 address in the message', async () => {
    const { connect } = fakeConnect({ kind: 'error', code: 'ECONNREFUSED' });
    const result = await checkTcp('2001:db8::5', 22, fakeDeps({ connect }));
    expect(result.outcome.detail).toContain('[2001:db8::5]:22');
  });
});

describe('checkSshBanner', () => {
  it('reads the identification line, ignoring lines before it', async () => {
    const socket = new FakeSocket();
    socket.send('Welcome to the jump host\r\nSSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\r\n');
    const outcome = await checkSshBanner(socket.asSocket());
    expect(outcome.status).toBe('ok');
    expect(outcome.data).toEqual({ banner: 'SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13' });
  });

  it('accepts a banner split across packets', async () => {
    const socket = new FakeSocket();
    socket.send('SSH-2.0-drop');
    setTimeout(() => socket.send('bear\r\n'), 5);
    const outcome = await checkSshBanner(socket.asSocket());
    expect(outcome.data).toEqual({ banner: 'SSH-2.0-dropbear' });
  });

  it('fails a protocol-1-only server', async () => {
    const socket = new FakeSocket();
    socket.send('SSH-1.5-ancient\r\n');
    expect((await checkSshBanner(socket.asSocket())).status).toBe('fail');
  });

  it('names what is really on the port', async () => {
    const socket = new FakeSocket();
    socket.send('220 ProFTPD Server ready.\r\n');
    const outcome = await checkSshBanner(socket.asSocket());
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('an FTP (or mail) server');
    expect(outcome.remediation).toContain('not the SSH port');
  });

  it('explains a server that hangs up without a banner', async () => {
    const socket = new FakeSocket();
    socket.hangUp();
    const outcome = await checkSshBanner(socket.asSocket());
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('without sending an SSH banner');
    expect(outcome.remediation).toContain('MaxStartups');
  });

  it('explains a port that accepts TCP but says nothing', async () => {
    const socket = new FakeSocket();
    const outcome = await checkSshBanner(socket.asSocket(), 20);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('sent nothing');
    expect(outcome.remediation).toContain('load balancer');
  });
});

describe('FTP', () => {
  it('parses single and multi-line replies only once complete', () => {
    expect(parseFtpReply('220 ready')).toBeNull();
    expect(parseFtpReply('220 ready\r\n')).toEqual({ code: 220, text: '220 ready' });
    expect(parseFtpReply('220-Welcome\r\n220-to the server\r\n')).toBeNull();
    expect(parseFtpReply('220-Welcome\r\nrules apply\r\n220 ready\r\n')).toEqual({
      code: 220,
      text: '220-Welcome rules apply 220 ready',
    });
  });

  it('accepts a 220 greeting', async () => {
    const socket = new FakeSocket();
    socket.send('220-Pure-FTPd\r\n220 You will be disconnected after 15 minutes.\r\n');
    const outcome = await checkFtpGreeting(socket.asSocket(), false);
    expect(outcome.status).toBe('ok');
    expect(outcome.data).toMatchObject({ code: 220 });
  });

  it('fails a 421 refusal with a hint about limits and bans', async () => {
    const socket = new FakeSocket();
    socket.send('421 Too many connections (8) from this IP\r\n');
    const outcome = await checkFtpGreeting(socket.asSocket(), false);
    expect(outcome.status).toBe('fail');
    expect(outcome.remediation).toContain('blocks this app’s IP');
  });

  it('suggests SFTP when the port speaks SSH', async () => {
    const socket = new FakeSocket();
    socket.send('SSH-2.0-OpenSSH_9.6\r\n');
    const outcome = await checkFtpGreeting(socket.asSocket(), false);
    expect(outcome.status).toBe('fail');
    expect(outcome.remediation).toContain('SFTP');
  });

  it('points a silent port at implicit FTPS', async () => {
    const socket = new FakeSocket();
    const outcome = await checkFtpGreeting(socket.asSocket(), false, 20);
    expect(outcome.status).toBe('fail');
    expect(outcome.remediation).toContain('FTPS (implicit)');
  });

  it('upgrades with AUTH TLS when the server answers 234', async () => {
    const socket = new FakeSocket((chunk, s) => {
      if (chunk === 'AUTH TLS\r\n') s.send('234 AUTH TLS OK.\r\n');
    });
    expect(await requestAuthTls(socket.asSocket())).toEqual({ ok: true });
  });

  it('fails when the server has no explicit TLS', async () => {
    const socket = new FakeSocket((_chunk, s) => s.send('500 This security scheme is not implemented\r\n'));
    const result = await requestAuthTls(socket.asSocket());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome.detail).toContain('does not offer explicit TLS');
  });
});

describe('checkTls', () => {
  const raw = () => new FakeSocket().asSocket();

  it('describes a trusted certificate', async () => {
    const { tlsConnect, calls } = fakeTls({ cert: { authorized: true } });
    const result = await checkTls({ socket: raw(), host: 'files.example.com', service: 'ftps', verify: true }, fakeDeps({ tlsConnect }));
    expect(result.outcome.status).toBe('ok');
    expect(result.outcome.detail).toContain('TLSv1.3, certificate for files.example.com issued by Let’s Encrypt');
    expect(calls[0]).toMatchObject({ servername: 'files.example.com', rejectUnauthorized: false });
  });

  it('sends no SNI for an IP address', async () => {
    const { tlsConnect, calls } = fakeTls({ cert: { authorized: true } });
    await checkTls({ socket: raw(), host: '203.0.113.10', service: 'https', verify: true }, fakeDeps({ tlsConnect }));
    expect(calls[0]).not.toHaveProperty('servername');
  });

  it('fails an untrusted certificate when verification is on', async () => {
    const { tlsConnect } = fakeTls({ cert: { authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT' } });
    const result = await checkTls({ socket: raw(), host: 'files.example.com', service: 'ftps', verify: true }, fakeDeps({ tlsConnect }));
    expect(result.outcome.status).toBe('fail');
    expect(result.outcome.detail).toContain('DEPTH_ZERO_SELF_SIGNED_CERT');
    expect(result.outcome.remediation).toContain('Verify TLS certificate');
  });

  it('only warns about it when verification is off', async () => {
    const { tlsConnect } = fakeTls({ cert: { authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT' } });
    const result = await checkTls({ socket: raw(), host: 'files.example.com', service: 'ftps', verify: false }, fakeDeps({ tlsConnect }));
    expect(result.outcome.status).toBe('warn');
  });

  it('warns about a certificate about to expire', async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toUTCString();
    const { tlsConnect } = fakeTls({ cert: { authorized: true, validTo: soon } });
    const result = await checkTls({ socket: raw(), host: 'files.example.com', service: 'https', verify: true }, fakeDeps({ tlsConnect }));
    expect(result.outcome.status).toBe('warn');
    expect(result.outcome.detail).toContain('expires in 3 days');
  });

  it('explains a port that does not speak TLS', async () => {
    const { tlsConnect } = fakeTls({ error: 'wrong version number' });
    const result = await checkTls({ socket: raw(), host: 'files.example.com', service: 'ftps-implicit', verify: true }, fakeDeps({ tlsConnect }));
    expect(result.outcome.status).toBe('fail');
    expect(result.outcome.remediation).toContain('FTPS (explicit)');
  });

  it('computes days until expiry', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(daysUntil('Jan 11 00:00:00 2026 GMT', now)).toBe(10);
    expect(daysUntil('not a date', now)).toBeNull();
  });
});

describe('checkHttpResponse', () => {
  const answering = (response: string) =>
    new FakeSocket((_chunk, s) => s.send(response)).asSocket();

  it('accepts any HTTP status and names the server', async () => {
    const socket = answering('HTTP/1.1 403 Forbidden\r\nServer: MinIO\r\nContent-Length: 0\r\n\r\n');
    const outcome = await checkHttpResponse(socket, 'minio.lan:9000');
    expect(outcome.status).toBe('ok');
    expect(outcome.detail).toBe('The endpoint answered HTTP 403 Forbidden (server: MinIO).');
  });

  it('warns when the service reports an error', async () => {
    const outcome = await checkHttpResponse(answering('HTTP/1.1 503 Service Unavailable\r\n\r\n'), 'x');
    expect(outcome.status).toBe('warn');
  });

  it('fails when the port does not speak HTTP', async () => {
    const outcome = await checkHttpResponse(answering('SSH-2.0-OpenSSH_9.6\r\n'), 'x', 30);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('an SSH server');
  });
});

describe('checkHostKeyPin', () => {
  const base = { host: 'web.example.com', port: 22 };

  it('passes when the host presents the pinned key', async () => {
    const outcome = await checkHostKeyPin({ ...base, pinned: FINGERPRINT, revealPresented: false }, fakeDeps());
    expect(outcome.status).toBe('ok');
  });

  it('warns that nothing is pinned yet', async () => {
    const outcome = await checkHostKeyPin({ ...base, pinned: null, revealPresented: false }, fakeDeps());
    expect(outcome.status).toBe('warn');
    expect(outcome.detail).toContain(FINGERPRINT);
  });

  it('shows an admin both keys on a mismatch', async () => {
    const outcome = await checkHostKeyPin({ ...base, pinned: OTHER_FINGERPRINT, revealPresented: true }, fakeDeps());
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain(FINGERPRINT);
    expect(outcome.detail).toContain(OTHER_FINGERPRINT);
  });

  it('keeps the presented key from everyone else', async () => {
    const outcome = await checkHostKeyPin({ ...base, pinned: OTHER_FINGERPRINT, revealPresented: false }, fakeDeps());
    expect(outcome.status).toBe('fail');
    expect(JSON.stringify(outcome)).not.toContain(FINGERPRINT);
  });

  it('asks for the pinned key type first, as a real connection does', async () => {
    const seen: (string | null | undefined)[] = [];
    const deps = fakeDeps({
      scanHostKey: async (_host, _port, _timeout, preferType) => {
        seen.push(preferType);
        return { fingerprint: FINGERPRINT, type: 'ecdsa-sha2-nistp256' };
      },
    });
    await checkHostKeyPin({ ...base, pinned: FINGERPRINT, pinnedType: 'ecdsa-sha2-nistp256', revealPresented: false }, deps);
    // Nothing pinned: no preference, the scan shows what a first connection would see
    await checkHostKeyPin({ ...base, pinned: null, pinnedType: 'ecdsa-sha2-nistp256', revealPresented: false }, deps);
    expect(seen).toEqual(['ecdsa-sha2-nistp256', null]);
  });

  it('fails when no key could be read', async () => {
    const deps = fakeDeps({ scanHostKey: () => Promise.reject(new Error('Connection closed before a host key was received')) });
    const outcome = await checkHostKeyPin({ ...base, pinned: FINGERPRINT, revealPresented: true }, deps);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('Connection closed');
  });
});
