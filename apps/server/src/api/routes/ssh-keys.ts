import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { sshKeys } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { vault } from '../../vault/index.js';
import { audit } from '../../audit/index.js';
import { generateKeyPair } from '../../ssh/keygen.js';

const importKeySchema = z.object({
  name: z.string().min(1).max(100),
  privateKey: z.string().min(1),
});

const generateKeySchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['rsa', 'ed25519', 'ecdsa']).default('ed25519'),
});

export async function sshKeyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req) => {
    const db = getDb();
    // Never return encryptedPrivateKey to the client
    return db
      .select({
        id: sshKeys.id,
        orgId: sshKeys.orgId,
        name: sshKeys.name,
        type: sshKeys.type,
        publicKey: sshKeys.publicKey,
        fingerprint: sshKeys.fingerprint,
        createdBy: sshKeys.createdBy,
        createdAt: sshKeys.createdAt,
        updatedAt: sshKeys.updatedAt,
      })
      .from(sshKeys)
      .where(eq(sshKeys.orgId, req.orgId))
      .all();
  });

  app.post('/import', async (req, reply) => {
    const body = importKeySchema.parse(req.body);
    const db = getDb();
    const id = nanoid();

    const { publicKey, fingerprint, type } = await parsePrivateKey(body.privateKey);
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

  app.post('/generate', async (req, reply) => {
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
    // One-time: return private key only at generation
    return reply
      .status(201)
      .send({ id, name: body.name, type: body.type, publicKey, fingerprint, privateKey });
  });

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const key = db
      .select()
      .from(sshKeys)
      .where(and(eq(sshKeys.id, id), eq(sshKeys.orgId, req.orgId)))
      .get();
    if (!key) return reply.status(404).send({ error: 'Not found' });

    db.delete(sshKeys).where(eq(sshKeys.id, id)).run();
    await audit(req, 'ssh_key.delete', 'ssh_key', id, key.name);
    return reply.status(204).send();
  });
}

async function parsePrivateKey(
  pem: string,
): Promise<{ publicKey: string; fingerprint: string; type: 'rsa' | 'ed25519' | 'ecdsa' }> {
  // Delegate to ssh2 utils in a real implementation
  const type: 'rsa' | 'ed25519' | 'ecdsa' = pem.includes('EC')
    ? 'ecdsa'
    : pem.includes('RSA')
      ? 'rsa'
      : 'ed25519';
  return { publicKey: '(parsed)', fingerprint: '(parsed)', type };
}
