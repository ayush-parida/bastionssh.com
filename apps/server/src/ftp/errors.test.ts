import { describe, it, expect } from 'vitest';
import { FTPError } from 'basic-ftp';
import { FtpError, isReplyError, toFtpError } from './errors.js';

function reply(code: number, message: string): FTPError {
  return new FTPError({ code, message });
}

describe('toFtpError', () => {
  it('passes an FtpError through untouched', () => {
    const err = new FtpError('nope', 418);
    expect(toFtpError(err)).toBe(err);
  });

  it('splits 550 between not-found and permission denied by wording', () => {
    expect(toFtpError(reply(550, '550 No such file or directory')).statusCode).toBe(404);
    expect(toFtpError(reply(550, '550 Permission denied')).statusCode).toBe(403);
    expect(toFtpError(reply(550, '550 Permission denied')).message).toBe('550 Permission denied');
  });

  it('maps the common reply codes', () => {
    expect(toFtpError(reply(530, '530 Login incorrect')).statusCode).toBe(403);
    expect(toFtpError(reply(421, '421 Service not available')).statusCode).toBe(502);
    expect(toFtpError(reply(425, "425 Can't open data connection")).statusCode).toBe(502);
    expect(toFtpError(reply(450, '450 File busy')).statusCode).toBe(409);
    expect(toFtpError(reply(552, '552 Quota exceeded')).statusCode).toBe(507);
    expect(toFtpError(reply(553, '553 Bad file name')).statusCode).toBe(400);
    expect(toFtpError(reply(502, '502 Command not implemented')).statusCode).toBe(400);
  });

  it('maps socket failures and timeouts', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:21'), {
      code: 'ECONNREFUSED',
    });
    expect(toFtpError(refused).statusCode).toBe(502);
    expect(toFtpError(refused).message).toMatch(/Could not reach/);
    expect(toFtpError(new Error('Timeout (control socket)')).statusCode).toBe(504);
    const cert = Object.assign(new Error('self signed certificate'), {
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    });
    expect(toFtpError(cert).statusCode).toBe(502);
  });

  it('falls back to the given message and a 502', () => {
    const err = toFtpError(undefined, 'Could not list');
    expect(err.statusCode).toBe(502);
    expect(err.message).toBe('Could not list');
  });

  it('recognises a server reply as distinct from a broken session', () => {
    expect(isReplyError(reply(550, 'x'))).toBe(true);
    expect(isReplyError(new Error('socket hang up'))).toBe(false);
    expect(isReplyError(new FtpError('x', 400))).toBe(false);
  });
});
