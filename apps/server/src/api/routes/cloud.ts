import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { CloudAccount, CloudProvider, CloudSyncStatus } from '@smt/shared';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { cloudAccounts, sshKeys } from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import { audit } from '../../audit/index.js';
import {
  CloudError,
  credentialHint,
  decodeCredentials,
  encodeCredentials,
  parseRegions,
  parseSummary,
  syncAccount,
  testAccount,
  testCredentials,
  unlinkAccountServers,
  type CloudAccountRow,
  type CloudCredentials,
} from '../../cloud/index.js';
import { parseServiceAccount } from '../../cloud/providers/gcp.js';

const awsSchema = z.object({
  accessKeyId: z.string().min(16).max(128),
  secretAccessKey: z.string().min(16).max(256),
});
const tokenSchema = z.string().min(8).max(512);
const gcpSchema = z.object({ serviceAccountJson: z.string().min(50).max(20_000) });
const azureSchema = z.object({
  tenantId: z.string().uuid(),
  clientId: z.string().uuid(),
  clientSecret: z.string().min(8).max(512),
  subscriptionId: z.string().uuid(),
});

const base = z.object({
  name: z.string().min(1).max(100),
  regions: z.array(z.string().min(1).max(32)).max(30).default([]),
  defaultUsername: z.string().min(1).max(64).default('root'),
  defaultKeyId: z.string().nullable().optional(),
  autoImport: z.boolean().default(true),
  syncEnabled: z.boolean().default(true),
});

const createSchema = z.discriminatedUnion('provider', [
  base.extend({ provider: z.literal('aws'), aws: awsSchema }),
  base.extend({ provider: z.literal('gcp'), gcp: gcpSchema }),
  base.extend({ provider: z.literal('azure'), azure: azureSchema }),
  base.extend({ provider: z.literal('digitalocean'), token: tokenSchema }),
  base.extend({ provider: z.literal('hetzner'), token: tokenSchema }),
]);

const credentialInputs = {
  aws: awsSchema.optional(),
  gcp: gcpSchema.optional(),
  azure: azureSchema.optional(),
  token: tokenSchema.optional(),
};

const updateSchema = base.partial().extend(credentialInputs);

type CredentialInput = z.infer<z.ZodObject<typeof credentialInputs>>;

/** Which input field carries the secret for each provider. */
const CREDENTIAL_FIELD: Record<CloudProvider, keyof CredentialInput> = {
  aws: 'aws',
  gcp: 'gcp',
  azure: 'azure',
  digitalocean: 'token',
  hetzner: 'token',
};

/**
 * Build credentials from whichever field the provider uses. Returns null when
 * none was sent (an update keeping the stored secret); throws a CloudError 400
 * when a field for a different provider was sent or the key file is unusable.
 */
function credentialsFrom(provider: CloudProvider, body: CredentialInput): CloudCredentials | null {
  const expected = CREDENTIAL_FIELD[provider];
  for (const field of Object.keys(credentialInputs) as (keyof CredentialInput)[]) {
    if (field !== expected && body[field] !== undefined) {
      throw new CloudError(`"${field}" credentials do not match a ${provider} account`, 400);
    }
  }
  if (body[expected] === undefined) return null;
  switch (provider) {
    case 'aws':
      return { kind: 'aws', ...body.aws! };
    case 'gcp':
      return parseServiceAccount(body.gcp!.serviceAccountJson);
    case 'azure':
      return { kind: 'azure', ...body.azure! };
    default:
      return { kind: 'token', token: body.token! };
  }
}

/** Credentials never leave the server; regions and the summary are stored as JSON. */
function toPublic(row: CloudAccountRow): CloudAccount {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    provider: row.provider as CloudProvider,
    credentialHint: row.credentialHint,
    regions: parseRegions(row.regions),
    defaultUsername: row.defaultUsername,
    defaultKeyId: row.defaultKeyId,
    autoImport: row.autoImport,
    syncEnabled: row.syncEnabled,
    lastSyncAt: row.lastSyncAt,
    lastStatus: row.lastStatus as CloudSyncStatus | null,
    lastError: row.lastError,
    lastSummary: parseSummary(row.lastSummary),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function loadAccount(orgId: string, id: string): CloudAccountRow | undefined {
  return getDb()
    .select()
    .from(cloudAccounts)
    .where(and(eq(cloudAccounts.id, id), eq(cloudAccounts.orgId, orgId)))
    .get();
}

function keyBelongsToOrg(orgId: string, keyId: string): boolean {
  return (
    getDb()
      .select({ id: sshKeys.id })
      .from(sshKeys)
      .where(and(eq(sshKeys.id, keyId), eq(sshKeys.orgId, orgId)))
      .get() !== undefined
  );
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof CloudError) return reply.status(err.statusCode).send({ error: err.message });
  throw err;
}

export async function cloudRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/accounts', async (req): Promise<CloudAccount[]> => {
    return getDb()
      .select()
      .from(cloudAccounts)
      .where(eq(cloudAccounts.orgId, req.orgId))
      .orderBy(desc(cloudAccounts.createdAt))
      .all()
      .map(toPublic);
  });

  app.post('/accounts', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    if (body.defaultKeyId && !keyBelongsToOrg(req.orgId, body.defaultKeyId)) {
      return reply.status(400).send({ error: 'Default SSH key not found' });
    }

    // Prove the credentials work before storing them
    let creds: CloudCredentials;
    try {
      creds = credentialsFrom(body.provider, body)!;
    } catch (err) {
      return sendError(reply, err);
    }
    const test = await testCredentials(body.provider, creds, body.regions);
    if (!test.ok) return reply.status(400).send({ error: test.error ?? 'Credential check failed' });

    const db = getDb();
    const id = nanoid();
    db.insert(cloudAccounts)
      .values({
        id,
        orgId: req.orgId,
        name: body.name,
        provider: body.provider,
        encryptedCredentials: await vault.encrypt(encodeCredentials(creds), id),
        credentialHint: credentialHint(creds),
        regions: JSON.stringify(body.regions),
        defaultUsername: body.defaultUsername,
        defaultKeyId: body.defaultKeyId ?? null,
        autoImport: body.autoImport,
        syncEnabled: body.syncEnabled,
        createdBy: req.user.id,
      })
      .run();

    await audit(req, 'cloud_account.create', 'cloud_account', id, body.name, {
      provider: body.provider,
      instanceCount: test.instanceCount,
    });
    return reply.status(201).send(toPublic(loadAccount(req.orgId, id)!));
  });

  app.patch('/accounts/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateSchema.parse(req.body);
    const existing = loadAccount(req.orgId, id);
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    if (body.defaultKeyId && !keyBelongsToOrg(req.orgId, body.defaultKeyId)) {
      return reply.status(400).send({ error: 'Default SSH key not found' });
    }

    const provider = existing.provider as CloudProvider;
    let creds: CloudCredentials | null;
    try {
      creds = credentialsFrom(provider, body);
    } catch (err) {
      return sendError(reply, err);
    }

    const regions = body.regions ?? parseRegions(existing.regions);
    if (creds) {
      const test = await testCredentials(provider, creds, regions);
      if (!test.ok) return reply.status(400).send({ error: test.error ?? 'Credential check failed' });
    }

    getDb()
      .update(cloudAccounts)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.regions !== undefined && { regions: JSON.stringify(body.regions) }),
        ...(body.defaultUsername !== undefined && { defaultUsername: body.defaultUsername }),
        ...(body.defaultKeyId !== undefined && { defaultKeyId: body.defaultKeyId }),
        ...(body.autoImport !== undefined && { autoImport: body.autoImport }),
        ...(body.syncEnabled !== undefined && { syncEnabled: body.syncEnabled }),
        ...(creds && {
          encryptedCredentials: await vault.encrypt(encodeCredentials(creds), id),
          credentialHint: credentialHint(creds),
          lastStatus: null,
          lastError: null,
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(cloudAccounts.id, id))
      .run();

    await audit(req, 'cloud_account.update', 'cloud_account', id, existing.name);
    return toPublic(loadAccount(req.orgId, id)!);
  });

  app.post('/accounts/:id/test', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = loadAccount(req.orgId, id);
    if (!existing) return reply.status(404).send({ error: 'Not found' });
    const result = await testAccount(existing);
    await audit(req, 'cloud_account.test', 'cloud_account', id, existing.name, { ok: result.ok });
    return result;
  });

  app.post('/accounts/:id/sync', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = loadAccount(req.orgId, id);
    if (!existing) return reply.status(404).send({ error: 'Not found' });
    try {
      const summary = await syncAccount(existing);
      await audit(req, 'cloud_account.sync', 'cloud_account', id, existing.name, { ...summary });
      return summary;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/accounts/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = loadAccount(req.orgId, id);
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    // Imported servers stay; they just stop being linked to a provider
    unlinkAccountServers(id);
    getDb().delete(cloudAccounts).where(eq(cloudAccounts.id, id)).run();
    await audit(req, 'cloud_account.delete', 'cloud_account', id, existing.name);
    return reply.status(204).send();
  });
}

// Exported for tests that need to decode what was stored
export { decodeCredentials };
