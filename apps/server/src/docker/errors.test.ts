import { describe, it, expect } from 'vitest';
import { DockerError, daemonMessage, dockerOff, fromDaemonStatus, fromTransportError, isForwardingRefused } from './errors.js';

describe('Docker error mapping', () => {
  it('keeps the daemon’s client errors and message', () => {
    const notFound = fromDaemonStatus(404, '{"message":"No such container: web"}');
    expect(notFound).toMatchObject({ statusCode: 404, message: 'No such container: web' });
    expect(fromDaemonStatus(409, '{"message":"conflict"}').statusCode).toBe(409);
    expect(fromDaemonStatus(400, '{"message":"bad parameter"}').statusCode).toBe(400);
    // "already started": nothing to do reads as a conflict
    expect(fromDaemonStatus(304, '').statusCode).toBe(409);
  });

  it('treats daemon failures as a bad gateway', () => {
    const err = fromDaemonStatus(500, '{"message":"driver failed"}');
    expect(err.statusCode).toBe(502);
    expect(err.message).toBe('Docker daemon error: driver failed');
  });

  it('reads a plain-text body when there is no JSON', () => {
    expect(daemonMessage('page not found\n')).toBe('page not found');
  });

  it('maps transport failures to 502, timeouts to 504, and passes through errors with a status', () => {
    expect((fromTransportError(new Error('socket hang up')) as DockerError).statusCode).toBe(502);
    expect((fromTransportError(new Error('Timed out while waiting for handshake')) as DockerError).statusCode).toBe(504);
    const withStatus = Object.assign(new Error('host key changed'), { statusCode: 409 });
    expect(fromTransportError(withStatus)).toBe(withStatus);
  });

  it('recognises sshd refusing the socket forward', () => {
    expect(isForwardingRefused(Object.assign(new Error('(SSH) Channel open failure: open failed'), { reason: 1 }))).toBe(true);
    expect(isForwardingRefused(Object.assign(new Error('(SSH) Channel open failure: unknown'), { reason: 3 }))).toBe(true);
    expect(isForwardingRefused(Object.assign(new Error('(SSH) Channel open failure: open failed'), { reason: 2 }))).toBe(false);
  });

  it('says Docker is off with a 400 and a code', () => {
    const err = dockerOff();
    expect(err.statusCode).toBe(400);
    expect(err.toJSON()).toMatchObject({ code: 'DOCKER_DISABLED' });
  });

  it('carries a diagnosis and a hint in its body', () => {
    expect(new DockerError('denied', 403, 'permission_denied', 'sudo usermod -aG docker deploy').toJSON()).toEqual({
      error: 'denied',
      code: 'DOCKER_PERMISSION_DENIED',
      problem: 'permission_denied',
      hint: 'sudo usermod -aG docker deploy',
    });
  });
});
