import type { Client } from 'basic-ftp';
import type { FtpProtocol } from '@smt/shared';
import { openClient, type FtpTarget } from './client.js';
import { isReplyError } from './errors.js';
import * as ops from './ops.js';
import type { FileBackend, FileSession, FtpConnectionRow } from './backend.js';

/** FTP, explicit FTPS and implicit FTPS over basic-ftp. */

export function toTarget(connection: FtpConnectionRow): FtpTarget {
  return {
    host: connection.host,
    port: connection.port,
    protocol: connection.protocol as FtpProtocol,
    username: connection.username,
    verifyTls: connection.verifyTls,
  };
}

function ftpSession(client: Client): FileSession {
  return {
    get closed() {
      return client.closed;
    },
    close: () => client.close(),
    // Only a plain FTP reply leaves the control connection in a known state
    survives: isReplyError,
    home: (rootPath) => ops.home(client, rootPath),
    list: (dir) => ops.list(client, dir),
    stat: (path) => ops.stat(client, path),
    linkTargetSize: (path) => ops.linkTargetSize(client, path),
    download: (path, destination) => ops.download(client, path, destination),
    upload: (source, path) => ops.upload(client, source, path),
    mkdir: (path) => ops.mkdir(client, path),
    rename: (from, to) => ops.rename(client, from, to),
    removeFile: (path) => ops.removeFile(client, path),
    removeEmptyDir: (path) => ops.removeEmptyDir(client, path),
    removeDirRecursive: (path) => ops.removeDirRecursive(client, path),
  };
}

export const ftpBackend: FileBackend = {
  async open(connection, password) {
    return ftpSession(await openClient(toTarget(connection), password));
  },
  testConnection: (connection, password) => ops.testConnection(toTarget(connection), password),
};
