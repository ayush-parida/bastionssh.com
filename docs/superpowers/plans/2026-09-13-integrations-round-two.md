# Integrations Round Two Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add eight alert channel types behind a per-type adapter registry, and add GCP Compute Engine and Azure Virtual Machines as cloud inventory providers.

**Architecture:** `notifications/channels/` holds one adapter per channel type (`prepare` validates and packs the vaulted target; `build` produces an outbound HTTP request). `deliver()` and the route call the registry instead of switching on type. `cloud/providers/gcp.ts` and `azure.ts` follow the existing adapter interface; each has a token helper and a pure `toInstance` mapper. `CloudCredentials` gains `gcp` and `azure` shapes threaded through the route schema and the account form.

**Tech Stack:** Fastify 5, zod, vitest, Node `crypto` (RS256 JWT), `fetch`, React 18.

**Spec:** `docs/superpowers/specs/2026-09-13-integrations-round-two-design.md`

## Global Constraints

- ESM, `.js` import suffixes, secrets via `vault.encrypt(value, rowId)`.
- Existing channel behaviour (webhook, slack, discord, email payloads, retry, 4xx-final) must not change; the existing `format.test.ts` and `notifications.test.ts` stay green throughout.
- New channel types: `teams | googlechat | telegram | ntfy | gotify | pushover | pagerduty | opsgenie`.
- Paging dedup key: `smt:<serverId>:<alertType>`; test flows trigger then resolve.
- Cloud providers add `gcp` and `azure`; no new npm dependencies.
- Tests: `cd apps/server && pnpm vitest run <file>`; shared must be rebuilt (`pnpm --filter @smt/shared build`) after type changes.

---

## File map

| Path | Responsibility |
| --- | --- |
| `packages/shared/src/types/notification.ts` (modify) | Channel type union, `CHANNEL_TYPE_META` (label, group, fields), request fields. |
| `packages/shared/src/types/cloud.ts` (modify) | `CloudProvider` adds gcp/azure; request gains `gcp`, `azure`. |
| `apps/server/src/notifications/channels/types.ts` (create) | `ChannelInput`, `OutboundRequest`, `ChannelAdapter`, helpers (`textSummary`, `severityRank`). |
| `apps/server/src/notifications/channels/{webhook,slack,discord,email,teams,googlechat,telegram,ntfy,gotify,pushover,pagerduty,opsgenie}.ts` (create) | One adapter each. |
| `apps/server/src/notifications/channels/index.ts` (create) | Registry: `getAdapter`, `CHANNEL_TYPES`. |
| `apps/server/src/notifications/channels/channels.test.ts` (create) | prepare/build tests per adapter. |
| `apps/server/src/notifications/format.ts` (modify) | Keep helpers; `buildPayload` delegates to adapters for backwards compatibility of tests. |
| `apps/server/src/notifications/index.ts` (modify) | `sendRequest`, Basic-auth split, follow-up; `deliver` via registry. |
| `apps/server/src/api/routes/notifications.ts` (modify) | Field schema per type; `prepare()` via registry. |
| `apps/server/src/api/routes/notifications.test.ts` (modify) | New-type creation cases. |
| `apps/server/src/cloud/types.ts` (modify) | Credentials union; `postJson`, `formToken` helpers. |
| `apps/server/src/cloud/providers/gcp.ts`, `azure.ts` (+ tests) (create) | Adapters. |
| `apps/server/src/cloud/providers/index.ts` (modify) | Register. |
| `apps/server/src/cloud/index.ts` (modify) | `credentialHint` for new kinds. |
| `apps/server/src/api/routes/cloud.ts` (+ test) (modify) | Schema branches, `toCredentials`. |
| `apps/web/src/components/settings/NotificationChannels.tsx` (modify) | Grouped select, per-type fields. |
| `apps/web/src/pages/CloudAccounts.tsx` (modify) | GCP/Azure fields. |
| `README.md`, `docs/ARCHITECTURE.md` (modify) | Tables. |

---

# Part D — Channel adapters

### Task D1: Shared channel metadata

**Files:** `packages/shared/src/types/notification.ts`

- [ ] Extend the union and add metadata the web form and the server schema both read:

```ts
export type NotificationChannelType =
  | 'webhook' | 'slack' | 'discord' | 'email'
  | 'teams' | 'googlechat' | 'telegram' | 'ntfy' | 'gotify' | 'pushover' | 'pagerduty' | 'opsgenie';

export type ChannelField = 'url' | 'recipients' | 'token' | 'chatId' | 'userKey' | 'routingKey' | 'region';
export type ChannelGroup = 'chat' | 'paging' | 'push' | 'other';

export interface ChannelTypeMeta {
  type: NotificationChannelType; label: string; group: ChannelGroup;
  fields: ChannelField[]; /** Where to get the credential. */ help: string;
  /** Placeholder for the url field, when present. */ urlPlaceholder?: string;
}
export const CHANNEL_TYPES: readonly ChannelTypeMeta[] = [ … 12 entries per spec §3.4/3.5 … ];
export function channelMeta(type: NotificationChannelType): ChannelTypeMeta;
```
`CreateNotificationChannelRequest` / `Update…` gain `token?`, `chatId?`, `userKey?`, `routingKey?`, `region?: 'us' | 'eu'`.
- [ ] Build shared; commit `feat(shared): channel type metadata for new notification channels`.

### Task D2: Adapter interface + port of the four existing types

**Files:** `channels/types.ts`, `channels/{webhook,slack,discord,email}.ts`, `channels/index.ts`, `format.ts`, `channels.test.ts`

- [ ] `types.ts`:

```ts
export interface ChannelInput { url?: string; recipients?: string[]; token?: string; chatId?: string; userKey?: string; routingKey?: string; region?: 'us' | 'eu'; }
export interface OutboundRequest { url: string; headers?: Record<string, string>; body: unknown; followUp?: OutboundRequest; }
export interface ChannelAdapter {
  type: NotificationChannelType;
  prepare(input: ChannelInput): { target: string; hint: string };
  build(target: string, event: AlertEvent, server: ServerRef, sentAt: string): OutboundRequest;
}
export function requireUrl(input: ChannelInput): string; // assertSafeUrl + ChannelInputError
export function title(event, server): string;            // "[CRITICAL] CPU high on web-01" (reuse emailSubject logic)
export function dedupKey(event): string;                 // smt:<serverId>:<type>
```
Move `ChannelInputError`, `InvalidWebhookUrlError`, `assertSafeUrl` into `channels/types.ts`; re-export from `notifications/index.ts` so imports elsewhere keep working.
- [ ] Port webhook/slack/discord: `build` returns `{ url: target, body: <existing payload> }`. Email: `prepare` validates recipients + `emailAvailable()`, `build` throws (never called). `format.ts` keeps `buildPayload` as `getAdapter(type).build(url, …).body` so the existing tests keep passing unchanged.
- [ ] Tests: `channels.test.ts` asserts slack/discord/webhook bodies equal the previous shapes (copy the three expectations from `format.test.ts`), and `prepare` masks the URL.
- [ ] Run `pnpm vitest run src/notifications`; commit `refactor(notifications): channel adapter registry`.

### Task D3: New adapters

**Files:** `channels/{teams,googlechat,telegram,ntfy,gotify,pushover,pagerduty,opsgenie}.ts`, `channels/index.ts`, `channels.test.ts`

Per adapter, write the test first, then the implementation. Key expectations:

- teams: body `.type === 'message'`, one attachment with `contentType 'application/vnd.microsoft.card.adaptive'`, card `body[0].text` contains title, `body[1]` FactSet with Server/Severity.
- googlechat: `{ text }` starting with `🚨`/`⚠️`/`✅`.
- telegram: `prepare({ token: '123:abc', chatId: '-100' })` → target `https://api.telegram.org/bot123:abc/sendMessage?chat_id=-100`, hint `chat -100`; `build` → url without query, body `{ chat_id: '-100', parse_mode: 'HTML', text: contains '<b>' }`; rejects when either half is missing.
- ntfy: `prepare({ url: 'https://u:p@ntfy.example.com/alerts' })` → hint `ntfy.example.com/alerts`; `build` → `{ url: 'https://u:p@ntfy.example.com', body: { topic: 'alerts', title, message, priority: 5 for critical / 4 warning / 3 resolved-test, tags: ['rotating_light'] … } }` (credentials remain in the URL; `sendRequest` splits them). Rejects a URL with no topic path.
- gotify: target is the given URL (must contain `token=`), body `{ title, message, priority: 8/5/2 }`.
- pushover: `prepare({ token, userKey })` → `https://api.pushover.net/1/messages.json?token=..&user=..`, hint `user …<last4>`; `build` → base URL, body `{ token, user, title, message, priority: 1/0/-1 }`.
- pagerduty: `prepare({ routingKey })` (min 20 chars) → hint `…<last4>`; open → `event_action 'trigger'`, `dedup_key 'smt:srv1:cpu_high'`, `payload.severity 'critical'|'warning'`, `payload.source` host; resolved → `'resolve'`; test → trigger with `dedup_key 'smt:test:<sentAt>'` and `followUp` resolve with the same key.
- opsgenie: `prepare({ routingKey, region: 'eu' })` → target `eu:<key>`; open → url `https://api.eu.opsgenie.com/v2/alerts`, header `Authorization: 'GenieKey <key>'`, body `{ alias: 'smt:srv1:cpu_high', priority: 'P2' for critical / 'P3' warning }`; resolved → `…/v2/alerts/smt%3Asrv1%3Acpu_high/close?identifierType=alias`; test → create + followUp close.

- [ ] Register all in `index.ts`; commit `feat(notifications): teams, google chat, telegram, ntfy, gotify, pushover, pagerduty, opsgenie channels`.

### Task D4: Delivery + routes + tests

**Files:** `notifications/index.ts`, `routes/notifications.ts`, `routes/notifications.test.ts`

- [ ] `sendRequest(req)`: split userinfo → `Authorization: Basic base64(user:pass)`; POST JSON with headers; retry policy as before; on success and `req.followUp`, send it once (no retry loop nesting beyond `withRetry`). `deliver()` = `channel.type === 'email' ? mail(...) : sendRequest(getAdapter(type).build(target, …))`.
- [ ] Route: replace `createSchema` with `z.object({ …base, type: z.enum(CHANNEL_TYPE_IDS), url?, recipients?, token?, chatId?, userKey?, routingKey?, region? })` and call `getAdapter(type).prepare(input)` (which enforces per-type requirements and throws `ChannelInputError`). PATCH: if any target field is present, `prepare({ ...fieldsFromBody })` for the existing type.
- [ ] Tests: create telegram (201, hint `chat -100`), telegram without chatId (400), pagerduty (201), opsgenie eu (201), ntfy with basic-auth URL (201, hint has no credentials), pushover (201); test-send for pagerduty with `fetch` mocked via `vi.stubGlobal('fetch', …)` asserts two calls (trigger, resolve) to `events.pagerduty.com`.
- [ ] Full suite; commit `feat(notifications): deliver through channel adapters; routes for new types`.

### Task D5: Web form

**Files:** `NotificationChannels.tsx`

- [ ] Select built from `CHANNEL_TYPES` with `<optgroup>` per group; Email disabled when SMTP off. Fields rendered from `meta.fields`: url (with `urlPlaceholder`), recipients textarea, token, chatId, userKey, routingKey, region select. Help line = `meta.help`. Submit sends only the fields in `meta.fields` (blank = keep on edit). Row icon by group.
- [ ] Web typecheck + build; commit `feat(web): new notification channel types`.

# Part E — GCP and Azure

### Task E1: Credentials + shared types

**Files:** `packages/shared/src/types/cloud.ts`, `cloud/types.ts`, `cloud/index.ts`

- [ ] Shared: `CloudProvider` adds `'gcp' | 'azure'`; `CLOUD_PROVIDERS`, labels ("Google Cloud", "Microsoft Azure"); `CreateCloudAccountRequest.gcp?: { serviceAccountJson: string }`, `azure?: { tenantId; clientId; clientSecret; subscriptionId }` (same on update).
- [ ] `cloud/types.ts`: union per spec §4.1; `postJson<T>(url, body, headers, timeoutMs)` and `postForm<T>(url, form, timeoutMs)` next to `httpJson` with the same error mapping; `getJson` accepts extra headers.
- [ ] `credentialHint`: gcp → `clientEmail`; azure → `${clientId.slice(0,8)}… / ${subscriptionId.slice(0,8)}…`.
- [ ] Build shared, typecheck; commit `feat(cloud): gcp and azure credential shapes`.

### Task E2: GCP adapter

**Files:** `providers/gcp.ts`, `providers/gcp.test.ts`

- [ ] Tests for `toInstance(raw, 'us-central1-a')`: fixture with `id: '123'`, `name`, `status: 'RUNNING'`, `machineType: '…/machineTypes/e2-medium'`, `networkInterfaces: [{ networkIP: '10.128.0.2', accessConfigs: [{ natIP: '34.1.2.3' }] }]`, `labels: { env: 'prod' }`, `tags: { items: ['http-server'] }` → `{ id: '123', name, region: 'us-central1', state: 'running', publicIp: '34.1.2.3', privateIp: '10.128.0.2', tags: ['env:prod', 'http-server'], instanceType: 'e2-medium' }`; `TERMINATED` → stopped; `STAGING` → other; no accessConfigs → publicIp null. `zoneToRegion('europe-west1-b') === 'europe-west1'`. `parseServiceAccount(json)` accepts a valid key and rejects one missing `private_key`.
- [ ] Implement: `buildJwt(creds, now)` (header/claims base64url, `crypto.sign('RSA-SHA256')`), `getAccessToken` (cache map keyed by clientEmail, refresh 5 min early), `listInstances` paging `aggregated/instances`, wrap errors.
- [ ] Register; commit `feat(cloud): gcp compute engine adapter`.

### Task E3: Azure adapter

**Files:** `providers/azure.ts`, `providers/azure.test.ts`

- [ ] Tests: `foldRows(rows)` merges two rows for the same VM id (one with `publicIp: null`, one with `'20.1.2.3'`) into one instance with the public IP; `toInstance(row)` maps `powerState: 'PowerState/running'` → running, `'PowerState/deallocated'` → stopped, `''` → other; id lowercased; tags `{ env: 'prod' }` → `['env:prod']`; `vmSize` → instanceType; `location` → region.
- [ ] Implement: `getAccessToken` (client credentials form POST, cached by clientId), `listInstances` posting the Resource Graph query with `$skipToken` paging, fold, wrap errors (403 → Reader hint).
- [ ] Register; commit `feat(cloud): azure virtual machines adapter`.

### Task E4: Routes + web + docs

**Files:** `routes/cloud.ts`, `routes/cloud.test.ts`, `CloudAccounts.tsx`, `README.md`, `docs/ARCHITECTURE.md`

- [ ] Schema branches: `gcp: z.object({ serviceAccountJson: z.string().min(50).max(20_000) })` parsed through `parseServiceAccount` (400 on failure); `azure: z.object({ tenantId: uuid, clientId: uuid, clientSecret: z.string().min(8).max(512), subscriptionId: uuid })`. PATCH accepts either for its provider. Tests: gcp with malformed JSON → 400; gcp with a generated RSA key in the JSON and mocked provider → 201, hint = client email; azure → 201.
- [ ] Form: provider options from `CLOUD_PROVIDERS`; gcp → textarea "Service account key (JSON)"; azure → four inputs; hints per spec §4.4. Regions field only for aws.
- [ ] Docs: README cloud table rows for Google Cloud and Azure; notification table rows for the new channels; ARCHITECTURE §4.3c/§4.3d one line each.
- [ ] Full verification; commit `feat(cloud): gcp and azure accounts in routes and ui; docs`.

## Self-review

Spec §3.1–3.5 → D1–D5; §4.1 → E1; §4.2 → E2; §4.3 → E3; §4.4 → E4; §4.5 tests spread across D2–D4, E2–E4. Names: `getAdapter`, `prepare`, `build`, `OutboundRequest.followUp`, `sendRequest`, `dedupKey`, `parseServiceAccount`, `zoneToRegion`, `foldRows`, `postJson`, `postForm`.
