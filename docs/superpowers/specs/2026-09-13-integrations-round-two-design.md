# Integrations Round Two — Design

**Date:** 2026-09-13
**Status:** Approved in scope by the user ("Okay proceed with these" on the recommended next steps); detailed choices made in an autonomous session — see "Assumptions".

## 1. Goal

Two follow-ons to the cloud integrations shipped earlier today:

| # | Piece | Extends | Outcome |
| --- | --- | --- | --- |
| D | **More alert channels**: Microsoft Teams, Telegram, ntfy, Gotify, Pushover, Google Chat, PagerDuty, Opsgenie | `notifications/` | Alerts reach the paging and chat tools people actually run, self-hosted ones included. Paging tools get open/resolve semantics instead of a stream of messages. |
| E | **GCP Compute Engine and Azure Virtual Machines** as cloud account providers | `cloud/` | The inventory sync covers the three big clouds plus the two popular small ones. |

Out of scope for this round (each is its own spec): single sign-on and SCIM, external secrets backends, metrics and log export, DNS providers, Terraform/Ansible import, Azure Blob storage.

## 2. Assumptions

1. **Channel logic moves into a registry of adapters**, one file per channel type, each owning its input validation, its stored target, and its outbound request. The delivery loop stops branching on type. Existing types (webhook, slack, discord, email) are ported onto the same interface with no behaviour change.
2. **Every non-email channel stores one vaulted "target" string**, as today. For channels that need two values (Telegram bot token + chat id, Pushover app token + user key) the adapter packs them into one URL-shaped string at create time and unpacks it at send time. No schema change.
3. **Paging tools dedupe by alert.** PagerDuty and Opsgenie receive `trigger` on open and `resolve` on resolve, keyed on `smt:<serverId>:<alertType>`. A channel test triggers and immediately resolves a test incident so the integration is proven without leaving an open page.
4. **Basic auth in a webhook URL is honoured.** `fetch` refuses URLs with embedded credentials, so `https://user:pass@ntfy.example.com/topic` is split into a clean URL plus an `Authorization: Basic` header. This is how ntfy, Gotify behind a proxy, and many internal webhooks are protected.
5. **Mattermost, Rocket.Chat and similar stay under Slack.** They accept the Slack payload; the UI option is relabelled "Slack / Mattermost".
6. **GCP uses a service-account JSON key** and a hand-rolled RS256 JWT bearer exchange (Node `crypto` only). The `google-auth-library` dependency tree is large for one token call. Scope requested: `compute.readonly`.
7. **Azure uses a service principal** (tenant id, client id, client secret, subscription id) with the client-credentials flow, and reads inventory through **Azure Resource Graph** in one query joining VMs, NICs and public IPs. This returns power state and addresses in a single call instead of two calls per VM. The principal needs the Reader role on the subscription.
8. **Regions for GCP and Azure are not user-configurable.** GCP's aggregated list and Resource Graph already return every zone/region.

## 3. Piece D — Channel adapters

### 3.1 Interface (`apps/server/src/notifications/channels/types.ts`)

```ts
export interface ChannelInput {            // what the route hands over after zod
  url?: string;
  recipients?: string[];
  token?: string;                          // telegram bot token, pushover app token
  chatId?: string;                         // telegram
  userKey?: string;                        // pushover
  routingKey?: string;                     // pagerduty integration key / opsgenie api key
  region?: 'us' | 'eu';                    // opsgenie
}

export interface OutboundRequest {
  url: string;
  method?: 'POST';
  headers?: Record<string, string>;
  body: unknown;                           // JSON-encoded
  /** For paging tools: a second request sent right after (test flows). */
  followUp?: OutboundRequest;
}

export interface ChannelAdapter {
  type: NotificationChannelType;
  /** Validate input, return what to vault and a display hint. Throws ChannelInputError. */
  prepare(input: ChannelInput): { target: string; hint: string };
  /** Build the HTTP request(s) for an event. Email returns null and is handled by the mail path. */
  build(target: string, event: AlertEvent, server: ServerRef, sentAt: string): OutboundRequest;
}
```

`index.ts` exports `getAdapter(type)` and `CHANNEL_TYPES`. Email keeps its separate path (`email.ts`) but gets a `prepare()` in the registry so the route is uniform.

### 3.2 Adapters

| type | stored target | request |
| --- | --- | --- |
| webhook | URL | JSON `AlertWebhookPayload` (unchanged) |
| slack | URL | `{ text }` (unchanged) |
| discord | URL | content + embed (unchanged) |
| email | `a@x,b@y` | mail path (unchanged) |
| teams | workflow/connector URL | Adaptive Card `{ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content }] }` — accepted by both Power Automate workflow webhooks and legacy connectors |
| googlechat | URL | `{ text }` with unicode markers instead of Slack shortcodes |
| telegram | `https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>` | POST to the URL without query, body `{ chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }` |
| ntfy | topic URL, optional `user:pass@` | POST to the origin, body `{ topic, title, message, priority (5/4/3), tags }`; Basic header from userinfo |
| gotify | `https://host/message?token=<app token>` | POST to that URL, body `{ title, message, priority }` |
| pushover | `https://api.pushover.net/1/messages.json?token=<app>&user=<key>` | POST to base URL, body `{ token, user, title, message, priority (1/0/-1) }` |
| pagerduty | routing key | POST `https://events.pagerduty.com/v2/enqueue` `{ routing_key, event_action: 'trigger' \| 'resolve', dedup_key, payload: { summary, source, severity, custom_details } }`; test = trigger + followUp resolve |
| opsgenie | `<region>:<api key>` | open: POST `https://api[.eu].opsgenie.com/v2/alerts` `{ message, alias, priority (P2/P3), details }`; resolve: POST `/v2/alerts/<alias>/close?identifierType=alias`; header `Authorization: GenieKey <key>`; test = create + followUp close |

Hints: URL-based → `maskUrl`; telegram → `chat <id>`; pushover → `user …<last4>`; pagerduty/opsgenie → `…<last4>`.

### 3.3 Delivery

`deliver()` becomes: decrypt target → `email ? mail(...) : sendRequest(adapter.build(...))`. `sendRequest` posts with the same retry policy, applies headers, splits URL userinfo into Basic auth, and sends `followUp` only after the first succeeds. Result recording unchanged.

### 3.4 Routes

The create schema becomes a discriminated union generated from a per-type map of required fields:

- `url`: webhook, slack, discord, teams, googlechat, ntfy, gotify
- `recipients`: email
- `token` + `chatId`: telegram
- `token` + `userKey`: pushover
- `routingKey`: pagerduty
- `routingKey` + `region`: opsgenie

PATCH accepts the same optional fields; when any target field is present the adapter's `prepare()` runs against the merged input (missing halves are rejected with a clear message, e.g. "Telegram needs both a bot token and a chat id").

### 3.5 Web

Type select grouped: Chat (Slack / Mattermost, Discord, Microsoft Teams, Google Chat, Telegram), Paging (PagerDuty, Opsgenie), Push (ntfy, Gotify, Pushover), Other (Email, Webhook). Field sets follow §3.4. Per-type helper line explains where to find the credential. Icons from lucide: MessageSquare, Bell, Smartphone, Siren, Webhook, Mail.

## 4. Piece E — GCP and Azure adapters

### 4.1 Credentials

```ts
export type CloudCredentials =
  | { kind: 'aws'; accessKeyId: string; secretAccessKey: string }
  | { kind: 'token'; token: string }
  | { kind: 'gcp'; projectId: string; clientEmail: string; privateKey: string }
  | { kind: 'azure'; tenantId: string; clientId: string; clientSecret: string; subscriptionId: string };
```

Create request: `gcp: { serviceAccountJson: string }` (the pasted key file; the server extracts `project_id`, `client_email`, `private_key`, `token_uri` and rejects anything else), `azure: { tenantId, clientId, clientSecret, subscriptionId }`. Hints: gcp → `client_email`; azure → `<clientId first 8>… / <subscription first 8>…`.

### 4.2 GCP (`cloud/providers/gcp.ts`)

- `getAccessToken(creds)`: JWT (`iss` = client email, `scope` = `https://www.googleapis.com/auth/compute.readonly`, `aud` = token URI, 1 h) signed RS256 with `crypto.sign`, exchanged at the token URI. Cached per client email until 5 min before expiry.
- `GET https://compute.googleapis.com/compute/v1/projects/{project}/aggregated/instances?maxResults=500[&pageToken]`. Items are keyed `zones/<zone>`; each has `instances[]` or a `warning` (no instances).
- `toInstance(raw, zone)`: id = `raw.id`, name, region = zone minus the trailing `-x`, state from `status` (`RUNNING`→running, `TERMINATED`/`STOPPING`/`SUSPENDED`/`SUSPENDING`→stopped, else other), privateIp = `networkInterfaces[0].networkIP`, publicIp = `networkInterfaces[0].accessConfigs[0].natIP`, tags = labels as `k:v` plus network `tags.items`, instanceType = last segment of `machineType`.
- Errors: token exchange 400/401 → CloudError 403 "GCP rejected the service account"; API 403 → 403 with Google's message; else 502/504.

### 4.3 Azure (`cloud/providers/azure.ts`)

- `getAccessToken(creds)`: POST `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` form `grant_type=client_credentials&scope=https://management.azure.com/.default`. Cached per client id.
- `POST https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01` with `{ subscriptions: [sub], query, options: { $top: 1000, $skipToken } }`. The query (§4.3.1) yields one row per VM ip-configuration; rows are folded by VM id, preferring a row that has a public IP.
- `toInstance(row)`: id = resource id (lowercased), name, region = `location`, state from `powerState` (`PowerState/running`→running, `PowerState/deallocated`/`PowerState/stopped`→stopped, else other), tags `k:v`, instanceType = `vmSize`.
- Errors: token 400/401 → 403 "Azure rejected the service principal"; Resource Graph 403 → 403 "principal lacks Reader on the subscription"; else 502/504.

#### 4.3.1 Resource Graph query

```
Resources
| where type =~ 'microsoft.compute/virtualmachines'
| mv-expand nic = properties.networkProfile.networkInterfaces
| extend nicId = tolower(tostring(nic.id))
| join kind=leftouter (
    Resources
    | where type =~ 'microsoft.network/networkinterfaces'
    | mv-expand ipconfig = properties.ipConfigurations
    | project nicId = tolower(id),
              privateIp = tostring(ipconfig.properties.privateIPAddress),
              publicIpId = tolower(tostring(ipconfig.properties.publicIPAddress.id))
  ) on nicId
| join kind=leftouter (
    Resources
    | where type =~ 'microsoft.network/publicipaddresses'
    | project publicIpId = tolower(id), publicIp = tostring(properties.ipAddress)
  ) on publicIpId
| project id, name, location, tags,
          vmSize = tostring(properties.hardwareProfile.vmSize),
          powerState = tostring(properties.extended.instanceView.powerState.code),
          privateIp, publicIp
```

### 4.4 Routes and web

`createSchema` gains `gcp` and `azure` branches; `toCredentials` extracts the service-account fields with a zod parse of the JSON. The account form shows a textarea for the GCP key file and four inputs for Azure. Permission hints: GCP "Compute Viewer role on the project"; Azure "Reader role on the subscription". Provider labels: "Google Cloud", "Microsoft Azure".

### 4.5 Testing

- Pure: every adapter's `prepare()` and `build()` (fixtures for each payload shape, dedup keys, Basic-auth splitting, follow-up on test), `toInstance` for GCP and Azure (fixtures shaped like the real responses, including the multi-row fold for Azure), the Azure row folding, the GCP zone→region rule.
- Routes: notification create for each new type with the required-field pairs; cloud create for gcp (bad JSON rejected, good JSON accepted with mocked provider) and azure.
- Not covered (no network): the real GCP token exchange, the real Resource Graph call. Flagged in the report.
