import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'fs';
import type { CreatedDbBackup, DbBackupList } from '@smt/shared';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { requireBrowserSession, requireStepUpIfPasskeys } from '../../auth/passkey.js';
import { audit } from '../../audit/index.js';
import { backupFile, backupNow, backupSettings, instanceOrgId, listAppBackups } from '../../backup/index.js';
import { isValidBackupName } from '../../backup/files.js';
import { databasePath } from '../../db/index.js';

/**
 * Backups of the app's own database. A backup holds every organization on the
 * instance (password hashes, encrypted credentials, audit history), so these
 * are for owners of the instance's organization only — the one the server
 * seeded — not for an owner of any org.
 */
async function requireInstanceOwner(req: FastifyRequest, reply: FastifyReply) {
  if (req.orgId !== instanceOrgId()) {
    return reply.status(403).send({ error: "Database backups are managed by the owners of the instance's first organization" });
  }
}

export async function backupRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireRole('owner'));
  app.addHook('preHandler', requireInstanceOwner);

  // Not audited: the page refetches the list, and a listing reveals nothing
  // the owner cannot already see. Creating and downloading a backup are.
  app.get('/', async (): Promise<DbBackupList> => {
    return { backups: listAppBackups(), settings: backupSettings() };
  });

  app.post('/', async (req, reply) => {
    if (databasePath() === ':memory:') {
      return reply.status(409).send({ error: 'The database is in memory; there is nothing to back up' });
    }
    let result: CreatedDbBackup;
    try {
      result = await backupNow('manual');
    } catch (err) {
      req.log.error({ err }, 'Manual database backup failed');
      await audit(req, 'backup.failed', 'backup', undefined, undefined, {
        reason: 'manual',
        error: (err as Error).message,
      });
      return reply.status(500).send({ error: 'Backup failed — see the server log' });
    }
    await audit(req, 'backup.create', 'backup', result.backup.name, result.backup.name, {
      reason: 'manual',
      size: result.backup.size,
      ...(result.uploaded !== null && { uploaded: result.uploaded }),
    });
    return reply.status(201).send(result);
  });

  /** The whole database, secrets included: a person at a browser, confirmed with their passkey if they have one. */
  app.get('/:name/download', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!requireBrowserSession(req, reply, 'Backups are downloaded from a signed-in browser, not with an API token')) {
      return reply;
    }
    if (!requireStepUpIfPasskeys(req, reply, req.orgId)) return reply;
    if (!isValidBackupName(name)) return reply.status(400).send({ error: 'Invalid backup name' });

    const file = backupFile(name);
    if (!file) return reply.status(404).send({ error: 'Backup not found' });

    await audit(req, 'backup.download', 'backup', name, name, { size: file.size });
    return reply
      .header('Content-Type', name.endsWith('.gz') ? 'application/gzip' : 'application/vnd.sqlite3')
      .header('Content-Length', String(file.size))
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .header('Cache-Control', 'no-store')
      .send(fs.createReadStream(file.path));
  });
}
