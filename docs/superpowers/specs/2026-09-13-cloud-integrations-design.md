# Cloud Provider Integrations — Design

**Date:** 2026-09-13
**Status:** Approved in principle by the user ("Okay proceed" on the recommended starting set); detailed choices below were made in an autonomous session — see "Assumptions".

## 1. Goal

Make BastionSSH aware of the clouds its servers live in, without turning it into a
cloud console. Three independent pieces, each extending a module that already exists:

| # | Piece | Extends | Outcome |
| --- | --- | --- | --- |
| A | **Email + Discord alert channels** | `notifications/` | Alerts reach an inbox or a Discord channel, not only Slack or a raw webhook. |
| B | **S3-compatible provider presets** | `storage/` | Picking "Cloudflare R2" or "Backblaze B2" pre-fills the endpoint shape, region and addressing style, so a connection works first time. |
| C | **Cloud accounts + inventory sync** | `servers/` | Register an AWS, DigitalOcean or Hetzner account once; its instances appear as servers, stay current, and are flagged when stopped or gone. |

They are decomposed on purpose. A and B are bounded changes; C is a new subsystem.
They share no code and can ship independently; the build order is A, B, C.

## 2. Assumptions

1. **SMTP is instance-wide, not per channel.** Configured through environment
   variables (`SMT_SMTP_URL`, `SMT_SMTP_FROM`), as Gitea and Grafana do. A channel
   only names recipients. If SMTP is not configured, the UI says so and disables the
   Email option; the API rejects creation with a clear 400.
2. **Discord uses an incoming webhook**, like Slack. No bot token, no OAuth.
3. **Presets are data, not code paths.** A preset fills the existing connection form;
   the stored row is the same `storage_connections` shape with a more specific
   `provider` value. Nothing in `ops.ts` branches on provider.
4. **Cloud credentials are long-lived tokens or key pairs.** AWS access key + secret,
   DigitalOcean personal access token, Hetzner Cloud API token. No STS/assume-role,
   no OAuth. Read-only permissions suffice and are recommended in the UI copy.
5. **Sync is one-way, cloud → BastionSSH.** We never create, stop or delete cloud
   resources. Sync only reads instance lists.
6. **Sync never deletes a server.** An instance that disappears from the provider is
   marked `missing`; the user decides whether to remove it. Stopped or missing cloud
   servers are excluded from the health sweep so they do not raise offline alerts.
7. **Auto-import is on by default and per account.** The purpose of registering an
   account is to stop adding servers by hand. Imported servers get the account's
   default SSH username and key.
8. **The sync loop is in-process on a plain interval**, like the health monitor, so it
   works in the default single-node deployment with no Redis.
9. **The AWS EC2 client is the official SDK** (`@aws-sdk/client-ec2`), matching the
   existing S3 dependency. DigitalOcean and Hetzner use plain `fetch`; their REST APIs
   are one paginated GET each and do not justify a dependency.

## 3. Piece A — Email and Discord channels

### 3.1 Data

No migration. `notification_channels.type` gains `discord` and `email`.
`encrypted_url` keeps its name but is treated as "encrypted target": for `email` it
holds the recipient list joined by commas. `target_hint` shows the first recipient
plus a count (`ops@example.com +2`). Recipients are not secret, but reusing the
column keeps one code path and one vault call.

### 3.2 API

`POST /api/notifications/channels` accepts either `url` (webhook, slack, discord) or
`recipients: string[]` (email, 1–20 addresses). The zod schema enforces the pairing
per type. `PATCH` accepts the same optional fields. A new
`GET /api/notifications/capabilities` returns `{ email: boolean }` so the client can
disable the option when SMTP is not configured.

### 3.3 Delivery

`deliver()` in `notifications/index.ts` branches once on channel type:

- `email` → `sendEmail(recipients, subject, text, html)` in a new `notifications/email.ts`
  wrapping nodemailer with a transport built lazily from `config.smtp`. Same
  retry-once policy as `post()`. Subject: `[CRITICAL] CPU high on web-1` /
  `[Resolved] …` / `Test notification`.
- everything else → `post(url, buildPayload(...))` as today.

`buildPayload` gains a `discord` branch producing `{ content, embeds: [{ title,
description, color }] }` with colour red / amber / green for critical / warning /
resolved. `format.ts` also gains `emailSubject()` and `emailBody()` (pure, tested).

### 3.4 Config

```
SMT_SMTP_URL   smtp://user:pass@host:587  (or smtps://…:465)  — optional
SMT_SMTP_FROM  "BastionSSH <alerts@example.com>"              — required if URL set
```

`config.smtp` is `null` when unset. Startup logs one line saying whether email
delivery is available.

### 3.5 Web

`NotificationChannels.tsx`: type select adds Discord and Email. For Email the URL
field becomes a "Recipients" textarea (comma or newline separated). Email option is
disabled with a tooltip when capabilities say SMTP is off. List rows get a Mail /
MessageCircle icon.

## 4. Piece B — Storage provider presets

### 4.1 Shared data

`packages/shared/src/types/storage.ts`:

```ts
export type StorageProvider =
  | 's3' | 'minio' | 'r2' | 'b2' | 'wasabi' | 'spaces' | 'gcs' | 'hetzner' | 'other';

export interface StorageProviderPreset {
  provider: StorageProvider;
  label: string;
  /** Endpoint template; `{x}` placeholders are filled by the user. null = AWS regional. */
  endpointTemplate: string | null;
  /** Placeholder shown for the endpoint input. */
  endpointExample: string | null;
  defaultRegion: string;
  /** Whether the region field means anything for this provider. */
  regionEditable: boolean;
  forcePathStyle: boolean;
  /** One-line hint rendered under the form. */
  hint: string;
}
export const STORAGE_PROVIDER_PRESETS: readonly StorageProviderPreset[];
```

Presets (endpoint template → default region → path style):

| Provider | Endpoint | Region | Path style |
| --- | --- | --- | --- |
| s3 | null (AWS regional) | us-east-1 | no |
| minio | `http://minio.internal:9000` (example) | us-east-1 | yes |
| r2 | `https://{account-id}.r2.cloudflarestorage.com` | auto | yes |
| b2 | `https://s3.{region}.backblazeb2.com` | us-west-004 | no |
| wasabi | `https://s3.{region}.wasabisys.com` | us-east-1 | yes |
| spaces | `https://{region}.digitaloceanspaces.com` | nyc3 | no |
| gcs | `https://storage.googleapis.com` | auto | yes |
| hetzner | `https://{location}.your-objectstorage.com` | eu-central | yes |
| other | user-supplied | us-east-1 | yes |

### 4.2 Server

`providerSchema` in `routes/storage.ts` becomes `z.enum` over the preset keys. The
"endpoint required unless s3" rule stays. `assertSafeEndpoint` is unchanged. A test
asserts every preset's example endpoint passes `assertSafeEndpoint` and that a
provider not in the preset list is rejected.

### 4.3 Web

`Storage.tsx`: the provider select is built from the presets. Choosing one sets
region, path style and endpoint placeholder; if the template has no placeholders the
endpoint is filled in. The hint renders under the form. Cards show the preset label.

## 5. Piece C — Cloud accounts and inventory sync

### 5.1 Architecture

```
                 ┌──────────── cloud/ ─────────────┐
routes/cloud.ts ─┤ providers/{aws,digitalocean,     │
                 │            hetzner}.ts  (list)  │──▶ provider APIs
scheduler.ts ────┤ sync.ts   (reconcile, pure plan) │
                 │ index.ts  (credentials, run)     │──▶ servers table
                 └──────────────────────────────────┘
```

- `providers/*.ts` each export `listInstances(credentials, opts) → CloudInstance[]`
  and `testCredentials(credentials)`. Each has a pure `toInstance(raw)` mapper that
  is unit-tested against captured API shapes.
- `sync.ts` exports `planSync(existing, discovered) → SyncPlan` (pure) and
  `applyPlan(db, account, plan)`. The plan lists creates, updates and
  `markMissing` ids, plus `skipped` (no usable IP).
- `scheduler.ts` mirrors the health monitor: `setInterval`, one account at a time,
  a `syncing` guard, `SMT_CLOUD_SYNC_INTERVAL` minutes (default 15, min 5).

### 5.2 Normalised instance

```ts
interface CloudInstance {
  id: string;            // i-0abc…, droplet id, hetzner id (as string)
  name: string;
  region: string;        // us-east-1, nyc3, fsn1
  state: 'running' | 'stopped' | 'other';
  publicIp: string | null;
  privateIp: string | null;
  tags: string[];        // normalised "key:value" or plain
  instanceType: string | null;
}
```

State mapping: AWS `running`→running, `stopped`/`stopping`→stopped, else other.
DO `active`→running, `off`→stopped, else other. Hetzner `running`→running,
`off`→stopped, else other. Host preference: public IPv4, then private IPv4; an
instance with neither is skipped on import and left untouched on update.

Tags: AWS `{Key, Value}` → `key:value` (the `Name` tag is used as the name and not
duplicated); DO tags are plain strings; Hetzner labels `{k: v}` → `k:v` (or `k` when
the value is empty). Every imported server also gets `cloud:<provider>` and its
region as tags.

### 5.3 Data

New table `cloud_accounts`:

| column | type | notes |
| --- | --- | --- |
| id, org_id, name | text | org FK cascade |
| provider | text | aws, digitalocean, hetzner |
| encrypted_credentials | text | vault-encrypted JSON |
| credential_hint | text | e.g. `AKIA…F3Q`, `dop_v1_…9c2`, `…a91f` |
| regions | text JSON | AWS only; `[]` = discover with DescribeRegions |
| default_username | text | default `root` |
| default_key_id | text nullable | FK ssh_keys, on delete set null |
| auto_import | bool | default true |
| sync_enabled | bool | default true |
| last_sync_at, last_status, last_error | | `ok` / `failed` |
| last_summary | text JSON | `{ discovered, created, updated, missing, skipped }` |
| created_by, created_at, updated_at | | |

`servers` gains nullable columns: `cloud_account_id` (FK, on delete set null),
`cloud_provider`, `cloud_instance_id`, `cloud_region`, `cloud_state`
(`running` / `stopped` / `other` / `missing`), `cloud_synced_at`. Unique index on
`(cloud_account_id, cloud_instance_id)`.

Migration `0005_add_cloud_accounts.sql` plus a journal entry.

### 5.4 Reconcile rules

For each discovered instance, match an existing server on
`(cloud_account_id, cloud_instance_id)`:

- **Match** → update `host` (if the instance has a usable IP), `cloud_region`,
  `cloud_state`, `cloud_synced_at`. Never touch name, tags, username, key, notes:
  those belong to the user after import.
- **No match and `auto_import`** → create a server: name from the instance (or the
  id), host, port 22, the account's username and key, tags as above, notes
  `Imported from <Provider> (<instance id>, <region>)`, `created_by` = account owner.
  Requires a usable IP; otherwise counted as skipped.
- **Existing cloud server not discovered** → `cloud_state = 'missing'`.
- **Previously missing and now discovered** → normal match path (state restored).

`runSweep()` in the health monitor excludes servers whose `cloud_state` is
`stopped` or `missing` (they are paused like monitoring-disabled hosts).

### 5.5 API — `/api/cloud`

| method | path | role | purpose |
| --- | --- | --- | --- |
| GET | `/accounts` | viewer | list (no credentials) |
| POST | `/accounts` | admin | create; runs `testCredentials` first and rejects with the provider's message on failure |
| PATCH | `/accounts/:id` | admin | update; credentials optional (blank = keep) |
| DELETE | `/accounts/:id` | admin | unlink servers (FK sets null, cloud columns cleared), delete account |
| POST | `/accounts/:id/test` | admin | credential check → `{ ok, error?, instanceCount? }` |
| POST | `/accounts/:id/sync` | operator | sync now → `SyncSummary` |

`GET /api/servers` and `/servers/:id` include a `cloud` object
(`{ accountId, provider, instanceId, region, state, syncedAt }`) or `null`.

Audit actions: `cloud_account.create|update|delete|test|sync`. A sync writes one
entry with the summary as metadata; the scheduler writes none (no actor) but logs.

### 5.6 Web

- New page `/cloud` ("Cloud Accounts", nav icon Cloud) with the card grid pattern
  from Storage: provider badge, credential hint, regions, last sync line
  (`Synced 3 min ago · 12 discovered, 1 new, 1 missing`), buttons Sync now / Edit /
  Delete. Form fields by provider: AWS (access key, secret, regions), DigitalOcean
  and Hetzner (token); shared: name, default username, default SSH key, auto-import,
  sync enabled. Help text names the minimum permission
  (`ec2:DescribeInstances` + `ec2:DescribeRegions`; DO read scope; Hetzner read token).
- Servers page: cloud-managed cards show a small badge `AWS · running` (amber for
  stopped, red for missing) and the tag filter works as before.

### 5.7 Error handling

Provider errors are mapped to a `CloudError(message, statusCode)`: 401/403 from the
provider → 403 "credentials rejected"; network/timeouts → 502/504 with the
provider's message; anything else → 502. The account row records `last_status`
and `last_error`; a failing account does not stop other accounts from syncing.

### 5.8 Testing

- Pure: `toInstance` per provider (fixtures), `planSync` (create / update / missing /
  skipped / user-edited fields untouched), tag normalisation.
- Routes: `cloud.test.ts` in the style of `storage.test.ts`, with the provider
  module mocked: create validates credentials, viewer cannot create, sync creates
  servers, second sync updates host and marks a vanished instance missing, delete
  unlinks servers, org isolation.
- Monitor: `runSweep` skips a `stopped` cloud server.

## 6. Out of scope

GCP and Azure compute (next step once the provider abstraction has proven itself),
SSM/Instance Connect, provider metrics, DNS, SSO, log export. Each is a follow-on
spec.
