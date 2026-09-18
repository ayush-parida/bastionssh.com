import { Client, type AccessOptions } from 'basic-ftp';
import type { FtpProtocol } from '@smt/shared';
import { toFtpError } from './errors.js';

export interface FtpTarget {
  host: string;
  port: number;
  protocol: FtpProtocol;
  username: string;
  verifyTls: boolean;
}

/** Socket inactivity — a healthy transfer keeps resetting it, a hung one does not. */
export const SOCKET_TIMEOUT_MS = 30_000;

export function buildAccessOptions(target: FtpTarget, password: string): AccessOptions {
  return {
    host: target.host,
    port: target.port,
    user: target.username,
    password,
    secure:
      target.protocol === 'ftps' ? true : target.protocol === 'ftps-implicit' ? 'implicit' : false,
    secureOptions: { rejectUnauthorized: target.verifyTls },
  };
}

/** Connect and log in. The caller owns the client and must `close()` it. */
export async function openClient(target: FtpTarget, password: string): Promise<Client> {
  const client = new Client(SOCKET_TIMEOUT_MS);
  try {
    await client.access(buildAccessOptions(target, password));
  } catch (err) {
    client.close();
    throw toFtpError(err, 'Could not connect to FTP server');
  }
  return client;
}
