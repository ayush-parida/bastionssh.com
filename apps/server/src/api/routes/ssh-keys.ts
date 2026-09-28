import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { ftpConnections, servers, sshKeys } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import type { GenerateSSHKeyResponse, SSHKey } from '@smt/shared';
import { nanoid } from 'nanoid';
import { vault } from '../../vault/index.js';
import { audit } from '../../audit/index.js';
import { describePrivateKey, generateKeyPair } from '../../ssh/keygen.js';

const importKeySchema = z.object({
  name: z.string().min(1).max(100),
  privateKey: z.string().min(1),
});

const generateKeySchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['rsa', 'ed25519', 'ecdsa']).default('ed25519'),
});

// Never return encryptedPrivateKey to the client
const publicColumns = {
  id: sshKeys.id,
  orgId: sshKeys.orgId,
  name: sshKeys.name,
  type: sshKeys.type,
  publicKey: sshKeys.publicKey,
  fingerprint: sshKeys.fingerprint,
  keyVersion: sshKeys.keyVersion,
  retiredAt: sshKeys.retiredAt,
  rotatedFromKeyId: sshKeys.rotatedFromKeyId,
  createdBy: sshKeys.createdBy,
  createdAt: sshKeys.createdAt,
  updatedAt: sshKeys.updatedAt,
};

export async function sshKeyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req) => {
    const db = getDb();
    return db.select(publicColumns).from(sshKeys).where(eq(sshKeys.orgId, req.orgId)).all();
  });

  app.post('/import', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = importKeySchema.parse(req.body);
    const db = getDb();
    const id = nanoid();

    // Throws a 400 for anything ssh2 could not use at connect time
    const { publicKey, fingerprint, type } = describePrivateKey(body.privateKey);
    const encryptedPrivateKey = await vault.encrypt(body.privateKey, id);

    db.insert(sshKeys)
      .values({
        id,
        orgId: req.orgId,
        name: body.name,
        type,
        publicKey,
        fingerprint,
        encryptedPrivateKey,
        keyVersion: 1,
        createdBy: req.user.id,
      })
      .run();

    await audit(req, 'ssh_key.create', 'ssh_key', id, body.name);
    return reply.status(201).send({ id, name: body.name, type, publicKey, fingerprint });
  });

  app.post('/generate', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = generateKeySchema.parse(req.body);
    const db = getDb();
    const id = nanoid();

    const { privateKey, publicKey, fingerprint } = await generateKeyPair(body.type);
    const encryptedPrivateKey = await vault.encrypt(privateKey, id);

    db.insert(sshKeys)
      .values({
        id,
        orgId: req.orgId,
        name: body.name,
        type: body.type,
        publicKey,
        fingerprint,
        encryptedPrivateKey,
        keyVersion: 1,
        createdBy: req.user.id,
      })
      .run();

    await audit(req, 'ssh_key.create', 'ssh_key', id, body.name);
    const key = db.select(publicColumns).from(sshKeys).where(eq(sshKeys.id, id)).get()!;
    // One-time: return private key only at generation
    const response: GenerateSSHKeyResponse = { key: key as SSHKey, privateKeyPem: privateKey };
    return reply.status(201).send(response);
  });

  app.delete('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const key = db
      .select()
      .from(sshKeys)
      .where(and(eq(sshKeys.id, id), eq(sshKeys.orgId, req.orgId)))
      .get();
    if (!key) return reply.status(404).send({ error: 'Not found' });

    // servers.default_key_id has no ON DELETE action, so the delete would hit the FK
    const inUse = db
      .select({ name: servers.name, orgId: servers.orgId })
      .from(servers)
      .where(eq(servers.defaultKeyId, id))
      .all();
    if (inUse.length > 0) {
      // Only name servers the caller can see
      const names = inUse.filter((s) => s.orgId === req.orgId).map((s) => s.name);
      return reply.status(409).send({
        error: `Key is in use as the default key for ${inUse.length} server(s)${
          names.length ? ` (${names.join(', ')})` : ''
        }. Assign those servers a different key before deleting it.`,
      });
    }

    // ftp_connections.ssh_key_id has no ON DELETE action either
    const fileConnections = db
      .select({ name: ftpConnections.name, orgId: ftpConnections.orgId })
      .from(ftpConnections)
      .where(eq(ftpConnections.sshKeyId, id))
      .all();
    if (fileConnections.length > 0) {
      const names = fileConnections.filter((c) => c.orgId === req.orgId).map((c) => c.name);
      return reply.status(409).send({
        error: `Key is used to log in to ${fileConnections.length} file connection(s)${
          names.length ? ` (${names.join(', ')})` : ''
        }. Switch those connections to another key or a password before deleting it.`,
      });
    }

    db.delete(sshKeys).where(eq(sshKeys.id, id)).run();
    await audit(req, 'ssh_key.delete', 'ssh_key', id, key.name);
    return reply.status(204).send();
  });
}
