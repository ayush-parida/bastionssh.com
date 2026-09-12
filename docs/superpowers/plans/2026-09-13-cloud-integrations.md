# Cloud Provider Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email and Discord alert channels, S3-compatible provider presets, and cloud account inventory sync (AWS EC2, DigitalOcean, Hetzner) to BastionSSH.

**Architecture:** Three independent pieces. A extends `apps/server/src/notifications/` with a nodemailer transport and a Discord payload. B adds a shared preset table consumed by the storage route's zod enum and the storage form. C adds a new `apps/server/src/cloud/` module (per-provider `listInstances`, a pure `planSync` reconciler, an in-process interval scheduler), a `cloud_accounts` table plus cloud columns on `servers`, routes under `/api/cloud`, and a `/cloud` page.

**Tech Stack:** Fastify 5, Drizzle (SQLite), zod, vitest, nodemailer, `@aws-sdk/client-ec2`, React 18 + react-query 5 + Tailwind, lucide-react.

**Spec:** `docs/superpowers/specs/2026-09-13-cloud-integrations-design.md`

## Global Constraints

- Node ≥ 20, pnpm 9, ESM; server imports use `.js` suffixes.
- Secrets go through `vault.encrypt(value, rowId)` and never leave the server.
- Roles: viewer reads; operator may trigger a sync; admin manages channels, connections and accounts. Enforce with `requireRole` server-side; hide with `useHasRole` client-side.
- Env: `SMT_SMTP_URL` (optional), `SMT_SMTP_FROM` (required if URL set), `SMT_CLOUD_SYNC_ENABLED` (default true), `SMT_CLOUD_SYNC_INTERVAL` minutes (default 15, min 5).
- Sync never deletes servers; missing instances get `cloud_state = 'missing'`; `stopped`/`missing` cloud servers are excluded from the health sweep.
- Audit action names: `notification_channel.*` (existing), `storage_connection.*` (existing), `cloud_account.create|update|delete|test|sync`.
- Tests: `cd apps/server && pnpm vitest run <file>`; typecheck: `pnpm -r run typecheck` from the repo root. The shared package must be built (`pnpm --filter @smt/shared build`) before the server typechecks against new shared types.
- Commit after each task, conventional-commit style, with the Claude co-author trailer.

---

## File map

| Path | Responsibility |
| --- | --- |
| `packages/shared/src/types/notification.ts` (modify) | `NotificationChannelType` adds `discord`, `email`; request types gain `recipients`; `NotificationCapabilities`. |
| `packages/shared/src/types/storage.ts` (modify) | `StorageProvider` union, `StorageProviderPreset`, `STORAGE_PROVIDER_PRESETS`. |
| `packages/shared/src/types/cloud.ts` (create) | `CloudProvider`, `CloudAccount`, `CloudInstance`, `SyncSummary`, request/response types. |
| `packages/shared/src/types/server.ts` (modify) | `Server.cloud`. |
| `packages/shared/src/types/audit.ts` (modify) | `cloud_account.*` actions. |
| `packages/shared/src/index.ts` (modify) | Export cloud types. |
| `apps/server/src/config/index.ts` (modify) | `smtp`, `cloudSync`. |
| `apps/server/src/notifications/format.ts` (modify) | Discord payload, `emailSubject`, `emailBody`, `describeRecipients`. |
| `apps/server/src/notifications/email.ts` (create) | nodemailer transport + `sendEmail`. |
| `apps/server/src/notifications/index.ts` (modify) | Branch delivery by type; `emailAvailable()`. |
| `apps/server/src/api/routes/notifications.ts` (modify) | Schema per type; capabilities route. |
| `apps/server/src/api/routes/notifications.test.ts` (create) | Route tests for email/discord. |
| `apps/server/src/api/routes/storage.ts` (modify) | provider enum from presets. |
| `apps/server/src/storage/presets.test.ts` (create) | Presets pass `assertSafeEndpoint`. |
| `apps/server/src/db/schema.ts` (modify) | `cloudAccounts`; cloud columns on `servers`. |
| `apps/server/src/db/migrations/0005_add_cloud_accounts.sql` + `meta/_journal.json` | Migration. |
| `apps/server/src/cloud/types.ts` (create) | `CloudCredentials`, `CloudError`, provider interface. |
| `apps/server/src/cloud/providers/aws.ts` (create) | EC2 listing + `toInstance`. |
| `apps/server/src/cloud/providers/digitalocean.ts` (create) | Droplets listing + `toInstance`. |
| `apps/server/src/cloud/providers/hetzner.ts` (create) | Servers listing + `toInstance`. |
| `apps/server/src/cloud/providers/index.ts` (create) | `getProvider(provider)`. |
| `apps/server/src/cloud/providers/*.test.ts` (create) | Mapper tests with fixtures. |
| `apps/server/src/cloud/sync.ts` (create) | `planSync`, `applyPlan`, `syncAccount`. |
| `apps/server/src/cloud/sync.test.ts` (create) | Pure reconcile tests. |
| `apps/server/src/cloud/index.ts` (create) | Credential encode/decode, `credentialHint`, `runSync(accountId)`, `testAccount`. |
| `apps/server/src/cloud/scheduler.ts` (create) | Interval loop. |
| `apps/server/src/api/routes/cloud.ts` (create) | `/api/cloud/accounts` routes. |
| `apps/server/src/api/routes/cloud.test.ts` (create) | Route tests with mocked provider. |
| `apps/server/src/api/routes/servers.ts` (modify) | `sanitize` adds `cloud`. |
| `apps/server/src/monitoring/scheduler.ts` (modify) | Exclude stopped/missing cloud servers. |
| `apps/server/src/api/app.ts`, `apps/server/src/index.ts` (modify) | Register route; start scheduler. |
| `apps/web/src/components/settings/NotificationChannels.tsx` (modify) | Discord + Email UI. |
| `apps/web/src/pages/Storage.tsx` (modify) | Preset-driven form. |
| `apps/web/src/pages/CloudAccounts.tsx` (create) | Accounts page. |
| `apps/web/src/pages/Servers.tsx` (modify) | Cloud badge. |
| `apps/web/src/App.tsx`, `apps/web/src/components/layout/Layout.tsx` (modify) | Route + nav. |
| `README.md`, `docs/ARCHITECTURE.md` (modify) | Feature and env docs. |

---

# Part A — Email and Discord channels

### Task A1: Shared types and SMTP config

**Files:**
- Modify: `packages/shared/src/types/notification.ts`
- Modify: `apps/server/src/config/index.ts`

**Produces:** `NotificationChannelType = 'webhook' | 'slack' | 'discord' | 'email'`; `CreateNotificationChannelRequest.url?: string; recipients?: string[]`; `NotificationCapabilities { email: boolean }`; `config.smtp: { url: string; from: string } | null`.

- [ ] **Step 1: Edit shared types**

```ts
export type NotificationChannelType = 'webhook' | 'slack' | 'discord' | 'email';

export interface CreateNotificationChannelRequest {
  name: string;
  type: NotificationChannelType;
  /** Required for webhook, slack and discord. */
  url?: string;
  /** Required for email: 1–20 addresses. */
  recipients?: string[];
  minSeverity?: AlertSeverity;
  notifyOnResolve?: boolean;
  enabled?: boolean;
}
// UpdateNotificationChannelRequest gains `recipients?: string[]`
export interface NotificationCapabilities {
  /** True when the instance has SMTP configured, so email channels can be created. */
  email: boolean;
}
```

- [ ] **Step 2: Add SMTP env to config**

In `envSchema`: `SMT_SMTP_URL: z.string().url().optional()`, `SMT_SMTP_FROM: z.string().min(3).optional()`. In `config`:

```ts
smtp: env.SMT_SMTP_URL ? { url: env.SMT_SMTP_URL, from: env.SMT_SMTP_FROM ?? '' } : null,
```

After `parsed`, if `SMT_SMTP_URL` is set without `SMT_SMTP_FROM`, print an error and `process.exit(1)` like the existing invalid-env path.

- [ ] **Step 3: Build shared, typecheck server** — `pnpm --filter @smt/shared build && pnpm --filter @smt/server typecheck`. Expected: passes (nothing consumes the new members yet).
- [ ] **Step 4: Commit** — `feat(notifications): shared types and smtp config for email/discord channels`

### Task A2: Format helpers (Discord payload, email subject/body, recipient hint)

**Files:**
- Modify: `apps/server/src/notifications/format.ts`
- Test: `apps/server/src/notifications/format.test.ts`

**Produces:**
```ts
export function emailSubject(event: AlertEvent, server: ServerRef): string;
export function emailBody(event: AlertEvent, server: ServerRef, sentAt: string): { text: string; html: string };
export function describeRecipients(recipients: string[]): string; // "a@x.com +2"
export function parseRecipients(stored: string): string[];        // split on ','
```
`buildPayload('discord', …)` returns `{ content: string; embeds: [{ title, description, color }] }`.

- [ ] **Step 1: Write failing tests** (append to `format.test.ts`)

```ts
describe('discord payload', () => {
  it('uses an embed coloured by severity', () => {
    const body = buildPayload('discord', { ...opened, severity: 'critical' }, SERVER, NOW) as {
      content: string; embeds: { title: string; description: string; color: number }[];
    };
    expect(body.embeds[0].color).toBe(0xef4444);
    expect(body.embeds[0].title).toContain('CPU high');
    expect(body.content).toContain('web-01');
  });
  it('turns green on resolve', () => {
    const body = buildPayload('discord', { ...opened, kind: 'resolved' }, SERVER, NOW) as { embeds: { color: number }[] };
    expect(body.embeds[0].color).toBe(0x22c55e);
  });
});

describe('email', () => {
  it('prefixes the subject with severity', () => {
    expect(emailSubject(opened, SERVER)).toBe('[WARNING] CPU high on web-01');
    expect(emailSubject({ ...opened, kind: 'resolved' }, SERVER)).toBe('[Resolved] CPU high on web-01');
    expect(emailSubject({ ...opened, kind: 'test', type: 'test' }, SERVER)).toBe('Test notification from Server Manager');
  });
  it('renders text and html bodies with the message and host', () => {
    const { text, html } = emailBody(opened, SERVER, NOW);
    expect(text).toContain('10.0.0.4');
    expect(text).toContain('CPU at 91.0%');
    expect(html).toContain('<strong>');
    expect(html).not.toContain('<script');
  });
  it('escapes html in the message', () => {
    const { html } = emailBody({ ...opened, message: '<b>x</b>' }, SERVER, NOW);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('recipients', () => {
  it('shows the first address and a count', () => {
    expect(describeRecipients(['a@x.com'])).toBe('a@x.com');
    expect(describeRecipients(['a@x.com', 'b@x.com', 'c@x.com'])).toBe('a@x.com +2');
  });
  it('round-trips through the stored form', () => {
    expect(parseRecipients('a@x.com,b@x.com')).toEqual(['a@x.com', 'b@x.com']);
    expect(parseRecipients('')).toEqual([]);
  });
});
```
(`NOW = '2026-09-13T10:00:00.000Z'`.)

- [ ] **Step 2: Run** `pnpm vitest run src/notifications/format.test.ts` — expect failures on missing exports.
- [ ] **Step 3: Implement**

```ts
const DISCORD_COLOR = { critical: 0xef4444, warning: 0xf59e0b, resolved: 0x22c55e, test: 0x3b82f6 } as const;

function eventTone(event: AlertEvent): keyof typeof DISCORD_COLOR {
  if (event.kind === 'resolved') return 'resolved';
  if (event.kind === 'test') return 'test';
  return event.severity;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function emailSubject(event: AlertEvent, server: ServerRef): string {
  if (event.kind === 'test') return 'Test notification from Server Manager';
  const prefix = event.kind === 'resolved' ? '[Resolved]' : `[${event.severity.toUpperCase()}]`;
  return `${prefix} ${alertLabel(event.type)} on ${server.name}`;
}

export function emailBody(event: AlertEvent, server: ServerRef, sentAt: string) {
  const lines = [
    summarize(event, server),
    '',
    `Server: ${server.name} (${server.host})`,
    ...(event.kind !== 'test' ? [`Alert: ${alertLabel(event.type)}`, `Severity: ${event.severity}`] : []),
    ...(event.value !== undefined ? [`Value: ${event.value}`] : []),
    ...(event.threshold !== undefined ? [`Threshold: ${event.threshold}`] : []),
    ...(event.openedAt ? [`Opened: ${event.openedAt}`] : []),
    `Sent: ${sentAt}`,
  ];
  const text = lines.join('\n');
  const html = `<p><strong>${escapeHtml(summarize(event, server))}</strong></p><pre style="font-family:monospace">${escapeHtml(lines.slice(2).join('\n'))}</pre>`;
  return { text, html };
}

export function describeRecipients(recipients: string[]): string {
  if (recipients.length === 0) return '';
  return recipients.length === 1 ? recipients[0]! : `${recipients[0]} +${recipients.length - 1}`;
}

export function parseRecipients(stored: string): string[] {
  return stored.split(',').map((s) => s.trim()).filter(Boolean);
}
```
In `buildPayload`, before the webhook fallthrough:
```ts
if (type === 'discord') {
  const tone = eventTone(event);
  return {
    content: summarize(event, server),
    embeds: [{
      title: event.kind === 'test' ? 'Test notification' : `${event.kind === 'resolved' ? 'Resolved: ' : ''}${alertLabel(event.type)}`,
      description: `${server.name} (${server.host})${event.kind === 'opened' ? `\n${event.message}` : ''}`,
      color: DISCORD_COLOR[tone],
    }],
  };
}
```
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** — `feat(notifications): discord payload and email formatting`

### Task A3: Email transport and delivery branch

**Files:**
- Create: `apps/server/src/notifications/email.ts`
- Modify: `apps/server/src/notifications/index.ts`
- Add dep: `pnpm --filter @smt/server add nodemailer && pnpm --filter @smt/server add -D @types/nodemailer`

**Produces:**
```ts
// email.ts
export function emailAvailable(): boolean;
export async function sendEmail(msg: { to: string[]; subject: string; text: string; html: string }): Promise<void>;
export function resetTransport(): void; // tests
```

- [ ] **Step 1: Implement `email.ts`**

```ts
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config/index.js';

const SEND_TIMEOUT_MS = 15_000;
let transport: Transporter | null = null;

export function emailAvailable(): boolean { return config.smtp !== null; }

function getTransport(): Transporter {
  if (!config.smtp) throw new Error('Email delivery is not configured (set SMT_SMTP_URL and SMT_SMTP_FROM)');
  if (!transport) {
    transport = nodemailer.createTransport(config.smtp.url, {
      connectionTimeout: SEND_TIMEOUT_MS, greetingTimeout: SEND_TIMEOUT_MS, socketTimeout: SEND_TIMEOUT_MS,
    });
  }
  return transport;
}

export function resetTransport(): void { transport = null; }

export async function sendEmail(msg: { to: string[]; subject: string; text: string; html: string }): Promise<void> {
  await getTransport().sendMail({ from: config.smtp!.from, to: msg.to.join(', '), ...msg });
}
```
- [ ] **Step 2: Branch `deliver()` in `index.ts`**

```ts
const target = await vault.decrypt(channel.encryptedUrl, channel.id);
const sentAt = new Date().toISOString();
if (channel.type === 'email') {
  const { text, html } = emailBody(event, server, sentAt);
  await withRetry(() => sendEmail({ to: parseRecipients(target), subject: emailSubject(event, server), text, html }));
} else {
  await post(target, buildPayload(channel.type as NotificationChannelType, event, server, sentAt));
}
```
Extract the retry loop from `post` into `withRetry(fn, isFinal)` so both paths share MAX_ATTEMPTS / RETRY_DELAY_MS; `post` keeps the 4xx-is-final rule. Re-export `emailAvailable` from `index.ts`.
- [ ] **Step 3: Typecheck** `pnpm --filter @smt/server typecheck`; run `pnpm vitest run src/notifications` — existing tests still pass.
- [ ] **Step 4: Commit** — `feat(notifications): email delivery via smtp`

### Task A4: Routes — per-type validation and capabilities

**Files:**
- Modify: `apps/server/src/api/routes/notifications.ts`
- Test: `apps/server/src/api/routes/notifications.test.ts` (create, modelled on `storage.test.ts` seed helpers)

- [ ] **Step 1: Write failing route tests**

Cases (admin unless noted):
1. `GET /api/notifications/capabilities` → `{ email: false }` in tests (no SMTP env).
2. `POST` discord with `url: 'https://discord.com/api/webhooks/1/abc'` → 201, `type: 'discord'`, `targetHint: 'discord.com/api/webhooks/1/…'`.
3. `POST` email with recipients when SMTP unset → 400 with message containing `SMTP`.
4. `POST` email with recipients when SMTP set (use `vi.mock('../../notifications/email.js', () => ({ emailAvailable: () => true, sendEmail: vi.fn() }))`) → 201, `targetHint: 'a@x.com +1'`.
5. `POST` email without recipients → 400. `POST` slack without url → 400. Recipient `'not-an-email'` → 400.
6. `PATCH` email channel `{ recipients: ['c@x.com'] }` → 200, `targetHint: 'c@x.com'`, `lastStatus: null`.
7. viewer `POST` → 403.

Split the test file into two `describe` blocks with the email mock applied via `vi.mock` at top and toggled through a `let emailOn = false` flag read by the mock's `emailAvailable`.

- [ ] **Step 2: Run** — expect failures (no capabilities route; discord rejected by enum).
- [ ] **Step 3: Implement**

```ts
const recipientsSchema = z.array(z.string().email().max(254)).min(1).max(20);
const baseCreate = z.object({
  name: z.string().min(1).max(100),
  minSeverity: z.enum(['warning', 'critical']).default('warning'),
  notifyOnResolve: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
const createSchema = z.discriminatedUnion('type', [
  baseCreate.extend({ type: z.enum(['webhook', 'slack', 'discord']), url: z.string().url().max(2000) }),
  baseCreate.extend({ type: z.literal('email'), recipients: recipientsSchema }),
]);
const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z.string().url().max(2000).optional(),
  recipients: recipientsSchema.optional(),
  minSeverity: z.enum(['warning', 'critical']).optional(),
  notifyOnResolve: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

/** What gets vaulted and how it is described, per channel type. */
function resolveTarget(type: NotificationChannelType, url?: string, recipients?: string[]):
  { target: string; hint: string } {
  if (type === 'email') {
    if (!recipients?.length) throw new ChannelInputError('Email channels need at least one recipient');
    if (!emailAvailable()) throw new ChannelInputError('Email delivery is not configured on this instance (set SMT_SMTP_URL and SMT_SMTP_FROM)');
    return { target: recipients.join(','), hint: describeRecipients(recipients) };
  }
  if (!url) throw new ChannelInputError('A webhook URL is required');
  assertSafeUrl(url);
  return { target: url, hint: maskUrl(url) };
}
```
`ChannelInputError` lives next to `InvalidWebhookUrlError` in `notifications/index.ts` (or make `InvalidWebhookUrlError` extend a common `ChannelInputError`). Create route: `const { target, hint } = resolveTarget(body.type, 'url' in body ? body.url : undefined, 'recipients' in body ? body.recipients : undefined)`. PATCH: if `body.url !== undefined || body.recipients !== undefined`, call `resolveTarget(existing.type, body.url, body.recipients)` and reset last-status fields. Add `app.get('/capabilities', async () => ({ email: emailAvailable() }))`.

- [ ] **Step 4: Run tests** — PASS. Run the whole server suite.
- [ ] **Step 5: Commit** — `feat(notifications): email and discord channel routes`

### Task A5: Web — channel form

**Files:**
- Modify: `apps/web/src/components/settings/NotificationChannels.tsx`

- [ ] **Step 1:** `ChannelForm` gains `recipients: string`; `type` becomes `NotificationChannelType`. Query `['notification-capabilities']` → `api.get<NotificationCapabilities>('/notifications/capabilities')`.
- [ ] **Step 2:** Type select options: Slack, Discord (webhook), Email, Webhook (JSON POST). Email `<option disabled={!caps?.email}>` with label suffix `(SMTP not configured)` when disabled.
- [ ] **Step 3:** When `form.type === 'email'` render a `<textarea>` "Recipients" (placeholder `ops@example.com, oncall@example.com`), else the URL input with placeholder per type (`https://discord.com/api/webhooks/…` for discord). On submit, split recipients on `/[\s,;]+/`, drop blanks; send `{ recipients }` for email and `{ url }` otherwise. On edit, blank means keep.
- [ ] **Step 4:** Row icon: `Hash` slack, `MessageCircle` discord, `Mail` email, `Webhook` webhook. Keep `targetHint` display.
- [ ] **Step 5:** `pnpm --filter @smt/web typecheck`. Commit — `feat(web): discord and email notification channels`

---

# Part B — Storage provider presets

### Task B1: Shared presets + server enum + tests

**Files:**
- Modify: `packages/shared/src/types/storage.ts`
- Modify: `apps/server/src/api/routes/storage.ts:27`
- Test: `apps/server/src/storage/presets.test.ts`

- [ ] **Step 1: Add presets to shared**

```ts
export type StorageProvider = 's3' | 'minio' | 'r2' | 'b2' | 'wasabi' | 'spaces' | 'gcs' | 'hetzner' | 'other';

export interface StorageProviderPreset {
  provider: StorageProvider;
  label: string;
  /** null = AWS regional endpoint. `{name}` placeholders are for the user to fill. */
  endpointTemplate: string | null;
  defaultRegion: string;
  regionEditable: boolean;
  forcePathStyle: boolean;
  hint: string;
}

export const STORAGE_PROVIDER_PRESETS: readonly StorageProviderPreset[] = [
  { provider: 's3', label: 'AWS S3', endpointTemplate: null, defaultRegion: 'us-east-1', regionEditable: true, forcePathStyle: false, hint: 'Leave the endpoint blank to use the AWS regional endpoint for the region.' },
  { provider: 'minio', label: 'MinIO', endpointTemplate: 'http://minio.internal:9000', defaultRegion: 'us-east-1', regionEditable: true, forcePathStyle: true, hint: 'Use the API port (9000 by default), not the console port.' },
  { provider: 'r2', label: 'Cloudflare R2', endpointTemplate: 'https://{account-id}.r2.cloudflarestorage.com', defaultRegion: 'auto', regionEditable: false, forcePathStyle: true, hint: 'Create an R2 API token with Object Read & Write; the account ID is in the R2 dashboard URL.' },
  { provider: 'b2', label: 'Backblaze B2', endpointTemplate: 'https://s3.{region}.backblazeb2.com', defaultRegion: 'us-west-004', regionEditable: true, forcePathStyle: false, hint: 'The endpoint and region are shown on the bucket page (e.g. s3.us-west-004.backblazeb2.com). Use an application key, not the master key.' },
  { provider: 'wasabi', label: 'Wasabi', endpointTemplate: 'https://s3.{region}.wasabisys.com', defaultRegion: 'us-east-1', regionEditable: true, forcePathStyle: true, hint: 'Pick the region your buckets live in; Wasabi does not redirect across regions.' },
  { provider: 'spaces', label: 'DigitalOcean Spaces', endpointTemplate: 'https://{region}.digitaloceanspaces.com', defaultRegion: 'nyc3', regionEditable: true, forcePathStyle: false, hint: 'Use a Spaces access key (API → Spaces Keys), not a personal access token.' },
  { provider: 'gcs', label: 'Google Cloud Storage', endpointTemplate: 'https://storage.googleapis.com', defaultRegion: 'auto', regionEditable: false, forcePathStyle: true, hint: 'Requires an HMAC key (Cloud Storage → Settings → Interoperability).' },
  { provider: 'hetzner', label: 'Hetzner Object Storage', endpointTemplate: 'https://{location}.your-objectstorage.com', defaultRegion: 'eu-central', regionEditable: false, forcePathStyle: true, hint: 'Location is fsn1, nbg1 or hel1.' },
  { provider: 'other', label: 'Other S3-compatible', endpointTemplate: null, defaultRegion: 'us-east-1', regionEditable: true, forcePathStyle: true, hint: 'Works with Ceph RGW, Garage, SeaweedFS, Linode, Scaleway, OVH and anything that speaks the S3 API.' },
];

export const STORAGE_PROVIDERS = STORAGE_PROVIDER_PRESETS.map((p) => p.provider) as [StorageProvider, ...StorageProvider[]];

/** Fill `{placeholders}` with example values so a template can be validated or shown. */
export function exampleEndpoint(preset: StorageProviderPreset): string | null {
  return preset.endpointTemplate?.replace(/\{[^}]+\}/g, (m) => m === '{region}' ? preset.defaultRegion : m === '{location}' ? 'fsn1' : 'abc123') ?? null;
}
```
- [ ] **Step 2: Write `presets.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { STORAGE_PROVIDER_PRESETS, exampleEndpoint } from '@smt/shared';
import { assertSafeEndpoint } from './keys.js';

describe('storage provider presets', () => {
  for (const preset of STORAGE_PROVIDER_PRESETS) {
    it(`${preset.provider} example endpoint is accepted`, () => {
      const example = exampleEndpoint(preset);
      if (example === null) { expect(preset.provider === 's3' || preset.provider === 'other').toBe(true); return; }
      expect(assertSafeEndpoint(example)).toBe(example);
    });
  }
  it('has unique providers and non-empty labels', () => {
    const ids = STORAGE_PROVIDER_PRESETS.map((p) => p.provider);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of STORAGE_PROVIDER_PRESETS) expect(p.label.length).toBeGreaterThan(0);
  });
});
```
- [ ] **Step 3:** Change `providerSchema = z.enum(STORAGE_PROVIDERS)` in `routes/storage.ts`. Add to `storage.test.ts`: `POST` with `provider: 'r2'` and endpoint `https://abc.r2.cloudflarestorage.com` → 201; `provider: 'gcs'` without endpoint → 400 (non-s3 needs endpoint); `provider: 'nope'` → 400.
- [ ] **Step 4:** Build shared, run `pnpm vitest run src/storage src/api/routes/storage.test.ts`. PASS.
- [ ] **Step 5: Commit** — `feat(storage): provider presets for r2, b2, wasabi, spaces, gcs, hetzner`

### Task B2: Web — preset-driven form

**Files:**
- Modify: `apps/web/src/pages/Storage.tsx`

- [ ] **Step 1:** Replace `PROVIDER_LABEL` with a lookup on `STORAGE_PROVIDER_PRESETS`. Build the `<select>` from presets.
- [ ] **Step 2:** `setProvider(provider)`: find preset; set `region: preset.defaultRegion`, `forcePathStyle: preset.forcePathStyle`, `endpoint: template has no `{` ? template ?? '' : ''` (keep user endpoint when editing and provider unchanged). Endpoint input placeholder = `preset.endpointTemplate ?? 'https://s3.amazonaws.com'`; region input `readOnly` when `!preset.regionEditable`.
- [ ] **Step 3:** Render `<p className="col-span-2 text-xs text-muted-foreground">{preset.hint}</p>` under the provider row. Subtitle: "Browse and manage S3-compatible buckets — AWS, MinIO, R2, B2 and more".
- [ ] **Step 4:** `pnpm --filter @smt/web typecheck`. Commit — `feat(web): storage provider presets in connection form`

---

# Part C — Cloud accounts and inventory sync

### Task C1: Shared cloud types, audit actions, Server.cloud

**Files:**
- Create: `packages/shared/src/types/cloud.ts`
- Modify: `packages/shared/src/types/server.ts`, `audit.ts`, `index.ts`

- [ ] **Step 1: Write `cloud.ts`**

```ts
export type CloudProvider = 'aws' | 'digitalocean' | 'hetzner';
export const CLOUD_PROVIDERS: readonly CloudProvider[] = ['aws', 'digitalocean', 'hetzner'];
export const CLOUD_PROVIDER_LABEL: Record<CloudProvider, string> = { aws: 'AWS', digitalocean: 'DigitalOcean', hetzner: 'Hetzner Cloud' };

export type CloudInstanceState = 'running' | 'stopped' | 'other';
/** `missing` = no longer returned by the provider. */
export type CloudServerState = CloudInstanceState | 'missing';

export interface CloudInstance {
  id: string; name: string; region: string; state: CloudInstanceState;
  publicIp: string | null; privateIp: string | null; tags: string[]; instanceType: string | null;
}

export type CloudSyncStatus = 'ok' | 'failed';

export interface SyncSummary { discovered: number; created: number; updated: number; missing: number; skipped: number; }

export interface CloudAccount {
  id: string; orgId: string; name: string; provider: CloudProvider;
  credentialHint: string; regions: string[]; defaultUsername: string; defaultKeyId: string | null;
  autoImport: boolean; syncEnabled: boolean;
  lastSyncAt: string | null; lastStatus: CloudSyncStatus | null; lastError: string | null; lastSummary: SyncSummary | null;
  createdBy: string; createdAt: string; updatedAt: string;
}

export interface AwsCredentialsInput { accessKeyId: string; secretAccessKey: string; }
export interface TokenCredentialsInput { token: string; }

export interface CreateCloudAccountRequest {
  name: string; provider: CloudProvider;
  aws?: AwsCredentialsInput; token?: string;
  regions?: string[]; defaultUsername?: string; defaultKeyId?: string | null;
  autoImport?: boolean; syncEnabled?: boolean;
}
export interface UpdateCloudAccountRequest {
  name?: string; aws?: AwsCredentialsInput; token?: string;
  regions?: string[]; defaultUsername?: string; defaultKeyId?: string | null;
  autoImport?: boolean; syncEnabled?: boolean;
}
export interface CloudTestResult { ok: boolean; error?: string; instanceCount?: number; }

export interface ServerCloudInfo {
  accountId: string | null; provider: CloudProvider; instanceId: string; region: string | null;
  state: CloudServerState; syncedAt: string | null;
}
```
- [ ] **Step 2:** `Server` gains `cloud: ServerCloudInfo | null;`. Audit adds `'cloud_account.create' | 'cloud_account.update' | 'cloud_account.delete' | 'cloud_account.test' | 'cloud_account.sync'`. Export from index.
- [ ] **Step 3:** Build shared. Web typecheck will fail where `Server` objects are constructed without `cloud` only if any exist (none expected). Commit — `feat(shared): cloud account types`

### Task C2: Schema + migration

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/migrations/0005_add_cloud_accounts.sql`; modify `meta/_journal.json`

- [ ] **Step 1: Schema**

```ts
export const cloudAccounts = sqliteTable('cloud_accounts', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  provider: text('provider').notNull(), // aws | digitalocean | hetzner
  encryptedCredentials: text('encrypted_credentials').notNull(), // vault JSON
  credentialHint: text('credential_hint').notNull(),
  regions: text('regions').notNull().default('[]'), // JSON, aws only
  defaultUsername: text('default_username').notNull().default('root'),
  defaultKeyId: text('default_key_id').references(() => sshKeys.id, { onDelete: 'set null' }),
  autoImport: integer('auto_import', { mode: 'boolean' }).notNull().default(true),
  syncEnabled: integer('sync_enabled', { mode: 'boolean' }).notNull().default(true),
  lastSyncAt: text('last_sync_at'),
  lastStatus: text('last_status'), // ok | failed
  lastError: text('last_error'),
  lastSummary: text('last_summary'), // JSON SyncSummary
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({ orgIdx: index('cloud_accounts_org_idx').on(t.orgId) }));
```
`servers` (declared after `cloudAccounts`? No — `cloudAccounts` references `sshKeys` and `servers` must reference `cloudAccounts`; declare `cloudAccounts` between `sshKeys` and `servers`) gains:
```ts
cloudAccountId: text('cloud_account_id').references(() => cloudAccounts.id, { onDelete: 'set null' }),
cloudProvider: text('cloud_provider'),
cloudInstanceId: text('cloud_instance_id'),
cloudRegion: text('cloud_region'),
cloudState: text('cloud_state'), // running | stopped | other | missing
cloudSyncedAt: text('cloud_synced_at'),
```
and a table-level `uniqueIndex('servers_cloud_instance_idx').on(t.cloudAccountId, t.cloudInstanceId)` (import `uniqueIndex`).

- [ ] **Step 2: Migration SQL**

```sql
CREATE TABLE `cloud_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`encrypted_credentials` text NOT NULL,
	`credential_hint` text NOT NULL,
	`regions` text DEFAULT '[]' NOT NULL,
	`default_username` text DEFAULT 'root' NOT NULL,
	`default_key_id` text,
	`auto_import` integer DEFAULT true NOT NULL,
	`sync_enabled` integer DEFAULT true NOT NULL,
	`last_sync_at` text,
	`last_status` text,
	`last_error` text,
	`last_summary` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_key_id`) REFERENCES `ssh_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cloud_accounts_org_idx` ON `cloud_accounts` (`org_id`);
--> statement-breakpoint
ALTER TABLE `servers` ADD `cloud_account_id` text REFERENCES cloud_accounts(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `servers` ADD `cloud_provider` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `cloud_instance_id` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `cloud_region` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `cloud_state` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD `cloud_synced_at` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `servers_cloud_instance_idx` ON `servers` (`cloud_account_id`,`cloud_instance_id`);
```
Journal entry: `{ "idx": 5, "version": "6", "when": 1777300000000, "tag": "0005_add_cloud_accounts", "breakpoints": true }`.

- [ ] **Step 3:** Run the existing server suite (`pnpm vitest run`) — migrations apply on `:memory:`; all green. Commit — `feat(db): cloud_accounts table and cloud columns on servers`

### Task C3: Provider mappers — DigitalOcean and Hetzner

**Files:**
- Create: `apps/server/src/cloud/types.ts`, `providers/digitalocean.ts`, `providers/hetzner.ts`, tests beside them.

**Produces:**
```ts
// types.ts
export type CloudCredentials = { kind: 'aws'; accessKeyId: string; secretAccessKey: string } | { kind: 'token'; token: string };
export class CloudError extends Error { constructor(message: string, readonly statusCode = 502) }
export interface ListOptions { regions: string[]; timeoutMs: number }
export interface CloudProviderAdapter {
  listInstances(creds: CloudCredentials, opts: ListOptions): Promise<CloudInstance[]>;
}
export function httpJson<T>(url: string, token: string, timeoutMs: number): Promise<T>; // bearer GET, maps 401/403 → CloudError 403, other non-2xx → CloudError 502, network → 502, timeout → 504
export function pickHost(i: { publicIp: string | null; privateIp: string | null }): string | null;
```
- [ ] **Step 1: Tests** (`digitalocean.test.ts`)

```ts
import { toInstance } from './digitalocean.js';
const droplet = {
  id: 3164444, name: 'web-1', status: 'active', size_slug: 's-1vcpu-1gb',
  region: { slug: 'nyc3' }, tags: ['web', 'prod'],
  networks: { v4: [{ ip_address: '10.132.0.5', type: 'private' }, { ip_address: '104.131.186.241', type: 'public' }], v6: [] },
};
it('maps a droplet', () => {
  expect(toInstance(droplet)).toEqual({
    id: '3164444', name: 'web-1', region: 'nyc3', state: 'running',
    publicIp: '104.131.186.241', privateIp: '10.132.0.5', tags: ['web', 'prod'], instanceType: 's-1vcpu-1gb',
  });
});
it('maps off → stopped and new → other', () => {
  expect(toInstance({ ...droplet, status: 'off' }).state).toBe('stopped');
  expect(toInstance({ ...droplet, status: 'new' }).state).toBe('other');
});
```
(`hetzner.test.ts`)
```ts
const server = {
  id: 42, name: 'db-1', status: 'running', server_type: { name: 'cx22' },
  datacenter: { location: { name: 'fsn1' } },
  public_net: { ipv4: { ip: '1.2.3.4' } }, private_net: [{ ip: '10.0.0.2' }],
  labels: { env: 'prod', team: '' },
};
it('maps a server and flattens labels', () => {
  expect(toInstance(server)).toEqual({
    id: '42', name: 'db-1', region: 'fsn1', state: 'running', publicIp: '1.2.3.4', privateIp: '10.0.0.2',
    tags: ['env:prod', 'team'], instanceType: 'cx22',
  });
});
it('handles a server with no public ip', () => {
  expect(toInstance({ ...server, public_net: { ipv4: null } }).publicIp).toBeNull();
});
```
- [ ] **Step 2:** Run → fail. **Step 3:** Implement `types.ts` (above), DigitalOcean (`GET https://api.digitalocean.com/v2/droplets?per_page=200&page=N` until `droplets.length < 200`), Hetzner (`GET https://api.hetzner.cloud/v1/servers?per_page=50&page=N` until `meta.pagination.next_page` is null). Both `listInstances` ignore `opts.regions`.
- [ ] **Step 4:** PASS. Commit — `feat(cloud): digitalocean and hetzner instance adapters`

### Task C4: Provider mapper — AWS EC2

**Files:**
- Add dep: `pnpm --filter @smt/server add @aws-sdk/client-ec2`
- Create: `providers/aws.ts`, `providers/aws.test.ts`, `providers/index.ts`

- [ ] **Step 1: Tests**

```ts
const raw = {
  InstanceId: 'i-0abc', State: { Name: 'running' }, InstanceType: 't3.micro',
  PublicIpAddress: '3.3.3.3', PrivateIpAddress: '172.31.0.5', Placement: { AvailabilityZone: 'us-east-1a' },
  Tags: [{ Key: 'Name', Value: 'api-1' }, { Key: 'Env', Value: 'prod' }],
};
it('maps an instance, using the Name tag and not duplicating it', () => {
  expect(toInstance(raw, 'us-east-1')).toEqual({
    id: 'i-0abc', name: 'api-1', region: 'us-east-1', state: 'running', publicIp: '3.3.3.3', privateIp: '172.31.0.5',
    tags: ['Env:prod'], instanceType: 't3.micro',
  });
});
it('falls back to the instance id as name and maps stopping → stopped, terminated → other', () => {
  expect(toInstance({ ...raw, Tags: [] }, 'us-east-1').name).toBe('i-0abc');
  expect(toInstance({ ...raw, State: { Name: 'stopping' } }, 'us-east-1').state).toBe('stopped');
  expect(toInstance({ ...raw, State: { Name: 'terminated' } }, 'us-east-1').state).toBe('other');
});
```
- [ ] **Step 2:** Implement. `listInstances`: regions = `opts.regions.length ? opts.regions : await discoverRegions()` (`DescribeRegionsCommand` on `us-east-1`); per region `paginateDescribeInstances` with `Filters: [{ Name: 'instance-state-name', Values: ['pending','running','stopping','stopped'] }]` (terminated instances are excluded so they become `missing`). Wrap SDK errors: names `AuthFailure`, `UnauthorizedOperation`, `InvalidClientTokenId`, `SignatureDoesNotMatch` → 403; `TimeoutError` → 504; else 502, message from the SDK. Client config: `{ region, credentials, maxAttempts: 2, requestHandler: { connectionTimeout: 10_000, requestTimeout: opts.timeoutMs } }`.
- [ ] **Step 3:** `providers/index.ts`: `export function getProvider(p: CloudProvider): CloudProviderAdapter`.
- [ ] **Step 4:** PASS; commit — `feat(cloud): aws ec2 instance adapter`

### Task C5: Pure reconcile — `planSync`

**Files:**
- Create: `apps/server/src/cloud/sync.ts`, `sync.test.ts`

**Produces:**
```ts
export interface ExistingCloudServer { id: string; cloudInstanceId: string; host: string; cloudState: string | null; }
export interface SyncPlan {
  create: CloudInstance[];
  update: { serverId: string; host: string | null; region: string; state: CloudInstanceState }[];
  markMissing: string[]; // server ids
  skipped: CloudInstance[];
}
export function planSync(existing: ExistingCloudServer[], discovered: CloudInstance[], autoImport: boolean): SyncPlan;
export function importTags(provider: CloudProvider, i: CloudInstance): string[]; // ['cloud:aws', region, ...i.tags] deduped
export function summarize(plan: SyncPlan, discovered: number): SyncSummary;
```
- [ ] **Step 1: Tests**

```ts
const inst = (over: Partial<CloudInstance>): CloudInstance => ({ id: 'a', name: 'a', region: 'r1', state: 'running', publicIp: '1.1.1.1', privateIp: '10.0.0.1', tags: [], instanceType: null, ...over });

it('creates unknown instances when auto-import is on, and skips those without an ip', () => {
  const plan = planSync([], [inst({ id: 'a' }), inst({ id: 'b', publicIp: null, privateIp: null })], true);
  expect(plan.create.map((i) => i.id)).toEqual(['a']);
  expect(plan.skipped.map((i) => i.id)).toEqual(['b']);
});
it('does not create when auto-import is off, but still updates and marks missing', () => {
  const plan = planSync([{ id: 's1', cloudInstanceId: 'a', host: '9.9.9.9', cloudState: 'running' }, { id: 's2', cloudInstanceId: 'z', host: '8.8.8.8', cloudState: 'running' }],
    [inst({ id: 'a', publicIp: '1.1.1.1' }), inst({ id: 'new' })], false);
  expect(plan.create).toEqual([]);
  expect(plan.update).toEqual([{ serverId: 's1', host: '1.1.1.1', region: 'r1', state: 'running' }]);
  expect(plan.markMissing).toEqual(['s2']);
});
it('prefers the public ip and keeps the old host when the instance has none', () => {
  const plan = planSync([{ id: 's1', cloudInstanceId: 'a', host: '9.9.9.9', cloudState: 'running' }],
    [inst({ id: 'a', publicIp: null, privateIp: null, state: 'stopped' })], true);
  expect(plan.update[0]).toEqual({ serverId: 's1', host: null, region: 'r1', state: 'stopped' });
});
it('does not mark an already-missing server again', () => {
  const plan = planSync([{ id: 's1', cloudInstanceId: 'gone', host: 'x', cloudState: 'missing' }], [], true);
  expect(plan.markMissing).toEqual([]);
});
it('builds import tags with provider and region first, deduplicated', () => {
  expect(importTags('aws', inst({ region: 'us-east-1', tags: ['Env:prod', 'us-east-1'] }))).toEqual(['cloud:aws', 'us-east-1', 'Env:prod']);
});
it('summarises a plan', () => {
  expect(summarize({ create: [inst({})], update: [], markMissing: ['s'], skipped: [] }, 1)).toEqual({ discovered: 1, created: 1, updated: 0, missing: 1, skipped: 0 });
});
```
- [ ] **Step 2–4:** Implement, PASS, commit — `feat(cloud): pure sync planner`

### Task C6: Sync runner, credentials, scheduler, monitor exclusion

**Files:**
- Create: `apps/server/src/cloud/index.ts`, `apps/server/src/cloud/scheduler.ts`
- Modify: `apps/server/src/cloud/sync.ts` (add `applyPlan`), `apps/server/src/config/index.ts`, `apps/server/src/monitoring/scheduler.ts`, `apps/server/src/index.ts`

**Produces:**
```ts
// cloud/index.ts
export type CloudAccountRow = typeof cloudAccounts.$inferSelect;
export function encodeCredentials(c: CloudCredentials): string;         // JSON
export function decodeCredentials(json: string): CloudCredentials;
export function credentialHint(c: CloudCredentials): string;            // 'AKIA…F3Q' | '…9c2f'
export function parseRegions(raw: string): string[];
export function parseSummary(raw: string | null): SyncSummary | null;
export async function testAccount(row: CloudAccountRow): Promise<CloudTestResult>;
export async function testCredentials(provider: CloudProvider, creds: CloudCredentials, regions: string[]): Promise<CloudTestResult>;
export async function syncAccount(row: CloudAccountRow): Promise<SyncSummary>; // throws CloudError on provider failure; records lastStatus either way
export function unlinkAccountServers(accountId: string): void;          // clears cloud_* columns
// sync.ts
export function applyPlan(account: CloudAccountRow, plan: SyncPlan, now: string): void; // single transaction
// scheduler.ts
export function startCloudSync(): void; export function stopCloudSync(): void; export async function runSyncSweep(): Promise<void>;
```
- [ ] **Step 1:** Config: `SMT_CLOUD_SYNC_ENABLED` (string → `!== 'false'`, default true), `SMT_CLOUD_SYNC_INTERVAL` (`z.coerce.number().min(5).default(15)`), `SMT_CLOUD_REQUEST_TIMEOUT` (`default(30_000)`); `config.cloudSync = { enabled, intervalMinutes, timeoutMs }`.
- [ ] **Step 2:** `applyPlan`: inside `db.transaction`, insert servers for `plan.create` (`id: nanoid()`, `orgId`, `createdBy: account.createdBy`, `name: i.name`, `host: pickHost(i)!`, `port: 22`, `username: account.defaultUsername`, `defaultKeyId: account.defaultKeyId`, `tags: JSON.stringify(importTags(provider, i))`, `notes: 'Imported from <Label> (<id>, <region>)'`, `cloudAccountId`, `cloudProvider`, `cloudInstanceId: i.id`, `cloudRegion`, `cloudState: i.state`, `cloudSyncedAt: now`); update rows for `plan.update` (`host` only when non-null, plus region/state/syncedAt/updatedAt); set `cloudState='missing', cloudSyncedAt=now` for `markMissing`.
- [ ] **Step 3:** `syncAccount`: decrypt creds → `getProvider(row.provider).listInstances(creds, { regions, timeoutMs })` → load existing `servers` where `cloudAccountId = row.id` → `planSync` → `applyPlan` → write `lastSyncAt/lastStatus='ok'/lastError=null/lastSummary` → return summary. On error write `lastStatus='failed', lastError`, rethrow as `CloudError`. `testCredentials`: `listInstances` and return `{ ok: true, instanceCount }` or `{ ok: false, error }`.
- [ ] **Step 4:** Scheduler mirrors `monitoring/scheduler.ts`: interval `intervalMinutes * 60_000`, first run after 15 s, `syncing` guard, iterates `cloudAccounts where syncEnabled` sequentially, logs per-account outcome, never throws. Start it in `src/index.ts` after `startHealthMonitor()`.
- [ ] **Step 5:** Monitor: in `runSweep`, `const isMonitored = (s) => s.monitoringEnabled && s.cloudState !== 'stopped' && s.cloudState !== 'missing'`; use it for both `monitored` and `excluded`.
- [ ] **Step 6:** Typecheck + full test run. Commit — `feat(cloud): sync runner, in-process scheduler, monitor exclusion for stopped instances`

### Task C7: Routes `/api/cloud` + server `cloud` field + tests

**Files:**
- Create: `apps/server/src/api/routes/cloud.ts`, `cloud.test.ts`
- Modify: `apps/server/src/api/routes/servers.ts` (`sanitize`), `apps/server/src/api/app.ts`

- [ ] **Step 1: Tests** (mock `../../cloud/providers/index.js` so `getProvider()` returns `{ listInstances: listMock }`; `listMock` is a `vi.fn` you reassign per test)

1. viewer `POST /api/cloud/accounts` → 403.
2. admin `POST` hetzner `{ name, provider: 'hetzner', token: 'tok', defaultUsername: 'root' }` with `listMock` resolving `[]` → 201; body has `credentialHint` ending in `…` prefix form, no token; `lastStatus: 'ok'` after creation test? (No: creation runs `testCredentials` but does not sync; `lastStatus` stays null.)
3. admin `POST` with `listMock` rejecting `new CloudError('bad token', 403)` → 403, body error `bad token`.
4. `POST` aws without `aws` credentials → 400; `POST` hetzner without `token` → 400.
5. operator `POST /accounts/:id/sync` with two instances → 200 `{ discovered: 2, created: 2, updated: 0, missing: 0, skipped: 0 }`; `GET /api/servers` shows both with `cloud.provider === 'hetzner'`, tags containing `cloud:hetzner`, `username: 'root'`.
6. Second sync where one instance is gone and the other's ip changed → `{ updated: 1, missing: 1 }`; server host updated; the other `cloud.state === 'missing'`. User-edited name (PATCH the server name first) is preserved.
7. `PATCH /accounts/:id { autoImport: false }` then sync with a new instance → `created: 0`.
8. `DELETE /accounts/:id` → 204; servers remain with `cloud: null`.
9. outsider org `GET /accounts/:id/sync` → 404.
10. `GET /api/cloud/accounts` never includes `encryptedCredentials`.

- [ ] **Step 2: Implement routes**

Zod:
```ts
const awsSchema = z.object({ accessKeyId: z.string().min(16).max(128), secretAccessKey: z.string().min(16).max(256) });
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
  base.extend({ provider: z.literal('digitalocean'), token: z.string().min(8).max(512) }),
  base.extend({ provider: z.literal('hetzner'), token: z.string().min(8).max(512) }),
]);
const updateSchema = base.partial().extend({ aws: awsSchema.optional(), token: z.string().min(8).max(512).optional() });
```
`toCredentials(body)` → `CloudCredentials`. Create: validate `defaultKeyId` belongs to org (404-ish 400 otherwise), run `testCredentials`; on `!ok` → 400 `{ error }`; insert with `encryptedCredentials: vault.encrypt(encodeCredentials(creds), id)`. `publicColumns` excludes `encryptedCredentials`; a `toPublic(row)` parses `regions` and `lastSummary`. Sync route: `requireRole('operator')`, `syncAccount(row)`, catch `CloudError` → its status; audit with summary metadata. Delete: `unlinkAccountServers(id)` then delete row. Register at `/api/cloud`.

`sanitize` in `servers.ts`:
```ts
cloud: row.cloudInstanceId && row.cloudProvider
  ? { accountId: row.cloudAccountId, provider: row.cloudProvider as CloudProvider, instanceId: row.cloudInstanceId, region: row.cloudRegion, state: (row.cloudState ?? 'other') as CloudServerState, syncedAt: row.cloudSyncedAt }
  : null,
```
- [ ] **Step 3:** PASS; full suite; commit — `feat(cloud): cloud account routes and server cloud info`

### Task C8: Web — Cloud Accounts page, nav, server badge

**Files:**
- Create: `apps/web/src/pages/CloudAccounts.tsx`
- Modify: `App.tsx`, `Layout.tsx`, `Servers.tsx`

- [ ] **Step 1:** Page modelled on `Storage.tsx`. Query `['cloud-accounts']`. Form state: `{ name, provider, accessKeyId, secretAccessKey, token, regions, defaultUsername, defaultKeyId, autoImport, syncEnabled }`. Provider select (disabled on edit). AWS shows access key / secret / regions (comma separated, hint "blank = all regions"); others show a token field. Keys query `['ssh-keys']` for the default key select. Permission help text per provider under the credential fields. Blank secret/token on edit = keep.
- [ ] **Step 2:** Cards: name, provider badge, `credentialHint`, regions (AWS), default `username` + key, last sync line with `lastSummary` counts or `lastError` in red, buttons: Sync now (operator+, shows toast with counts), Edit, Delete (confirm text: "Servers imported from this account are kept and unlinked."). Auto-import / sync toggles inline like channel Enable/Disable.
- [ ] **Step 3:** Nav item `{ to: '/cloud', label: 'Cloud Accounts', icon: Cloud }` after Object Storage; route `<Route path="cloud" element={<CloudAccountsPage />} />`.
- [ ] **Step 4:** Servers card: if `s.cloud`, render `<span title="…">{CLOUD_PROVIDER_LABEL[s.cloud.provider]} · {s.cloud.state}</span>` badge with `bg-amber-500/10 text-amber-600` for stopped, `bg-red-500/10 text-red-600` for missing, muted otherwise. Invalidate `['servers']` after a sync from the cloud page.
- [ ] **Step 5:** `pnpm --filter @smt/web typecheck && pnpm --filter @smt/web build`. Commit — `feat(web): cloud accounts page and server cloud badges`

### Task C9: Docs

- [ ] README: feature bullets for email/Discord, presets, cloud accounts; env table rows for `SMT_SMTP_URL`, `SMT_SMTP_FROM`, `SMT_CLOUD_SYNC_ENABLED`, `SMT_CLOUD_SYNC_INTERVAL`. ARCHITECTURE: section `4.3c Cloud Inventory Sync (/server/cloud)` describing adapters, planner, scheduler, and the missing/stopped rules. Commit — `docs: cloud integrations`

---

## Self-review

- Spec §3 (A) → A1–A5. §4 (B) → B1–B2. §5 (C) → C1–C9; §5.4 rules → C5/C6; §5.7 errors → C3/C4 `CloudError`; §5.8 tests → C3–C7.
- Names used consistently: `planSync`, `applyPlan`, `syncAccount`, `testCredentials`, `getProvider`, `CloudError`, `pickHost`, `importTags`, `summarize` (cloud/sync.ts — distinct module from notifications' `summarize`), `emailAvailable`, `sendEmail`, `resolveTarget`, `STORAGE_PROVIDERS`, `STORAGE_PROVIDER_PRESETS`, `exampleEndpoint`.
