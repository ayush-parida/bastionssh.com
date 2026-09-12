# Architecture

This document describes the architecture of **Server Management Tool (SMT)** — an open-source, self-hosted, browser-based platform for managing SSH keys, servers, saved commands, scheduled jobs, and AI assistance for teams.

---

## 1. Goals & Non-Goals

### Goals

- **Self-hosted first.** A single team/company runs a single instance they own.
- **Browser-based UX.** Everything is accessible from a modern browser; no desktop client required.
- **Easy distribution.** Ship as a single Docker image, `docker compose` stack, or static binary.
- **Secure by default.** SSH keys and secrets are encrypted at rest with a key the operator controls.
- **Bring your own AI.** Pluggable AI providers (OpenAI, Anthropic, any OpenAI-compatible local model).
- **Collaboration.** Multi-user organizations with RBAC, shared resources, and audit logging.
- **Extensible.** Clear module boundaries so providers, schedulers, and integrations can be swapped.

### Non-Goals

- Multi-tenant SaaS (a single instance is single-organization-by-default; orgs are an internal grouping for teams).
- Replacing full-blown configuration management tools (Ansible, Salt, Puppet).
- Replacing observability platforms (Prometheus, Grafana, Datadog).

---

## 2. High-Level System Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              User's Infrastructure                            │
│                                                                               │
│   ┌────────────┐         ┌──────────────────────────────┐         ┌────────┐  │
│   │  Browser   │ HTTPS   │         SMT Instance         │  SSH    │ Server │  │
│   │  (xterm.js │◄───────►│  ┌────────────┐ ┌─────────┐  │◄───────►│ Fleet  │  │
│   │  + React)  │   WS    │  │  Web / API │ │ Worker  │  │ (22)    │        │  │
│   └────────────┘         │  │  (Node)    │ │ (BullMQ │  │         └────────┘  │
│                          │  └─────┬──────┘ │  Cron)  │  │                     │
│                          │        │        └────┬────┘  │                     │
│                          │   ┌────▼─────┐  ┌────▼────┐  │                     │
│                          │   │ Postgres │  │  Redis  │  │                     │
│                          │   │  (data)  │  │ (queue) │  │                     │
│                          │   └──────────┘  └─────────┘  │                     │
│                          │                              │                     │
│                          │   ┌──────────────────────┐   │                     │
│                          │   │ Encrypted secrets    │   │                     │
│                          │   │ vault (libsodium)    │   │                     │
│                          │   └──────────────────────┘   │                     │
│                          └──────────────┬───────────────┘                     │
└─────────────────────────────────────────┼─────────────────────────────────────┘
                                          │
                                  ┌───────▼────────┐
                                  │  AI Provider   │  (OpenAI / Anthropic /
                                  │  (configured)  │   Ollama / vLLM / etc.)
                                  └────────────────┘
```

Everything inside the dashed boundary runs on the operator's infrastructure. The only external dependency is the AI provider the operator chooses (which can also be local).

---

## 3. Tech Stack

| Layer           | Choice                                                          | Why                                                       |
| --------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| Frontend        | **React + Vite + TypeScript**, TailwindCSS, shadcn/ui, xterm.js | Modern, fast, great terminal emulator support             |
| Backend API     | **Node.js + Fastify** (TypeScript)                              | Fast, WebSocket-friendly, large ecosystem                 |
| SSH             | **ssh2** (Node)                                                 | Pure JS SSH client, supports streams + WebSocket bridging |
| Database        | **PostgreSQL** (default) / **SQLite** (single-user)             | Relational data, mature                                   |
| ORM             | **Drizzle ORM**                                                 | Lightweight, TS-first, easy migrations                    |
| Queue/Scheduler | **BullMQ** on **Redis**                                         | Reliable cron + retry semantics                           |
| Auth            | **Lucia** (sessions) + OAuth/OIDC                               | Self-hosted-friendly, no SaaS dependency                  |
| Secrets at rest | **libsodium** (XChaCha20-Poly1305)                              | Authenticated encryption, modern primitives               |
| Realtime        | **WebSockets** (native + `ws`)                                  | Terminal streaming, live job logs                         |
| AI Abstraction  | Internal `AIProvider` interface                                 | Pluggable: OpenAI / Anthropic / OpenAI-compatible         |
| Packaging       | **Docker** (multi-arch), **pkg/Bun** for single binary          | Easy distribution                                         |
| Reverse Proxy   | User's choice (Caddy / Nginx / Traefik)                         | TLS termination outside the app                           |

> The stack is opinionated to keep the project approachable for contributors. Components like the queue, DB, and AI provider are abstracted behind interfaces so they can be swapped.

---

## 4. Component Overview

### 4.1 Web Frontend (`/web`)

- React SPA served by the API process (or as static files behind a CDN).
- Pages: Dashboard, Servers, Keys, Saved Commands, Cron Jobs, Audit Log, AI Chat, Settings.
- Communicates with the API over REST + WebSocket.
- Renders interactive SSH sessions using **xterm.js** over a WebSocket bridge.

### 4.2 API Server (`/server/api`)

- Fastify HTTP server exposing REST + WebSocket endpoints.
- Owns: authentication, RBAC, CRUD for resources, SSH session brokering, AI proxying.
- Stateless; can be horizontally scaled (sessions are sticky per WebSocket).

### 4.3 Worker (`/server/worker`)

- BullMQ consumer process.
- Executes scheduled cron jobs by opening short-lived SSH sessions.
- Streams stdout/stderr to Postgres and (optionally) live to subscribed browsers via Redis pub/sub.
- Handles retries, backoff, and failure notifications.

### 4.3b Health Monitor (`/server/monitoring`)

Agentless fleet monitoring. Deliberately **not** queue-backed: it runs on a plain
`setInterval` inside the API process so health checks keep working in the default
single-node deployment, where there is no Redis. A missed sweep is not worth
persisting or retrying — the next one is a minute away.

- `probe.ts` — the read-only shell probe (`/proc/uptime`, `/proc/loadavg`,
  `/proc/stat`, `/proc/meminfo`, `df -Pk`, `ps`, `who`) plus a pure parser. Every
  field is optional, so a host missing `/proc` still yields a usable sample.
- `collector.ts` — resolves credentials, runs the probe over a short-lived
  (unpooled) SSH connection, writes a `server_metrics` row, and updates the
  server's `server_health` row. Never throws: a failed check is a recorded data
  point, not an exception.
- `alerts.ts` — evaluates thresholds into conditions and reconciles them against
  what is already open, so a flapping metric does not open a new alert per sweep.
- `scheduler.ts` — the interval loop, bounded concurrency, and retention pruning.

CPU utilisation is a delta of `/proc/stat` jiffies against the previous stored
sample, so the first check after a restart or reboot reports no CPU figure rather
than a wrong one.

### 4.3c Cloud Inventory Sync (`/server/cloud`)

Pulls compute instances from a provider account into the `servers` table and keeps
them current. Read-only and one-way: the app never creates, stops or deletes cloud
resources. Like the health monitor it runs in-process on a plain interval
(`SMT_CLOUD_SYNC_INTERVAL` minutes) so it needs no Redis.

- `providers/{aws,digitalocean,hetzner}.ts` — one adapter per provider, each with a
  pure `toInstance()` mapper from the provider's wire shape to a normalised
  `CloudInstance` (id, name, region, running/stopped/other, public and private IP,
  tags, instance type). AWS uses `@aws-sdk/client-ec2`; the other two are one
  paginated `fetch` each. Errors become a `CloudError` carrying an HTTP status
  (403 for rejected credentials, 504 for timeouts, 502 otherwise).
- `sync.ts` — `planSync()` is pure: existing cloud servers plus discovered instances
  in, a plan of creates / updates / mark-missing / skipped out. `applyPlan()` writes
  it in one transaction. A matched server only has host, region and state
  refreshed; name, tags, credentials and notes belong to the user after import.
- `index.ts` — credential encode/decode (vault-encrypted JSON), `testCredentials()`
  (run before an account is saved), `syncAccount()` (records the outcome on the
  account row either way), and `unlinkAccountServers()` for account deletion.
- `scheduler.ts` — the interval loop; accounts sync one at a time and one failure
  never stops the next.

Servers carry `cloud_account_id`, `cloud_provider`, `cloud_instance_id`,
`cloud_region`, `cloud_state` and `cloud_synced_at`, unique on
`(cloud_account_id, cloud_instance_id)`. Instances the provider no longer lists are
marked `missing`, never deleted. The health sweep skips `stopped` and `missing`
cloud servers so they do not raise offline alerts.

### 4.3d Alert Notifications (`/server/notifications`)

Alert events from the health monitor fan out to every enabled channel of the
organisation, filtered by minimum severity and the resolve opt-in. Channel types:
`slack` and `discord` (incoming webhooks, provider-specific payloads), `webhook`
(structured JSON) and `email` (SMTP via nodemailer, configured instance-wide by
`SMT_SMTP_URL` / `SMT_SMTP_FROM`). A channel's target — the webhook URL or the
recipient list — is vault-encrypted; only a masked hint is returned to the client.
Delivery is fire-and-forget with one retry; a 4xx from a webhook is final.

### 4.4 SSH Broker (`/server/ssh`)

- Wraps `ssh2`. Responsibilities:
  - Decrypt key material on demand (never persisted in plaintext, never logged).
  - Open interactive shells, exec channels, and SFTP channels.
  - Bridge a `pty` to a WebSocket frame stream.
  - Enforce per-connection limits and timeouts.

#### SFTP file transfer (`/server/ssh/sftp.ts`)

- Rides the same `ssh2` connection and the same stored credentials as the terminal —
  no separate protocol, port, or credential set.
- Connections are pooled per `orgId:serverId:userId`, so a channel is never shared
  across users. Idle connections close after 5 minutes; the timer only fires when no
  operation is in flight, and editing or deleting a server evicts its pooled channels.
- Uploads and downloads stream end to end (`application/octet-stream` raw body in,
  `createReadStream` out) — file contents never buffer fully in the API process.
  Uploads are capped by `SMT_SFTP_MAX_UPLOAD_BYTES`.
- Client-supplied paths must be absolute and are normalized before use; `..` segments
  collapse rather than escaping. Recursive directory deletion is opt-in per request.
- Every operation writes an `sftp.*` audit entry recording the path.

REST surface, all under `/api/sftp/:serverId`:

| Method   | Path                       | Purpose                          |
| -------- | -------------------------- | -------------------------------- |
| `GET`    | `/list?path=`              | Directory listing (`.` = `$HOME`) |
| `GET`    | `/download?path=`          | Stream a file to the client      |
| `GET`    | `/read?path=`              | Text contents for the inline editor (2 MiB cap) |
| `PUT`    | `/file?path=`              | Upload a raw body to that path   |
| `POST`   | `/mkdir`                   | Create a directory               |
| `POST`   | `/rename`                  | Rename or move                   |
| `DELETE` | `/file?path=&recursive=`   | Delete a file or directory       |

### 4.4b Object Storage (`/server/storage`)

S3-compatible bucket and object management, covering AWS S3, MinIO, and anything
else that speaks the S3 API. Built on `@aws-sdk/client-s3` (+ `lib-storage` for
streaming multipart uploads), which MinIO itself recommends for Node.

- `keys.ts` — pure helpers: key/prefix normalisation (no `..`, no leading slash,
  prefixes end in `/`), bucket-name validation, endpoint safety check.
- `client.ts` — builds the `S3Client`. Always sets
  `requestChecksumCalculation: 'WHEN_REQUIRED'` (newer SDKs default to CRC32 trailers
  that older MinIO releases and some providers reject) and `followRegionRedirects`.
- `ops.ts` — thin wrappers over SDK commands; every failure is mapped to a
  `StorageError` carrying an HTTP status (404 missing bucket/key, 403 bad
  credentials, 409 bucket conflicts, 502/504 unreachable/timeout).
- `index.ts` — resolves a connection for the caller's org, decrypts the secret, and
  caches one client per connection until the row changes.

Downloads stream the SDK body straight to the response; uploads pipe a raw
`application/octet-stream` body through `lib-storage`'s `Upload` (single PUT below
one part, multipart above). Recursive deletes page through `ListObjectsV2` and use
`DeleteObjects` in batches of 1000, falling back to single deletes for providers
that reject batch deletes.

REST surface, all under `/api/storage`:

| Method   | Path                                                | Purpose                                      |
| -------- | --------------------------------------------------- | -------------------------------------------- |
| `GET`    | `/connections`                                      | List connections (secret never returned)     |
| `GET`    | `/connections/:id`                                  | One connection                               |
| `POST`   | `/connections`                                      | Create                                       |
| `PATCH`  | `/connections/:id`                                  | Update (omit `secretAccessKey` to keep it)   |
| `DELETE` | `/connections/:id`                                  | Delete                                       |
| `POST`   | `/connections/:id/test`                             | `ListBuckets` round-trip, result recorded    |
| `GET`    | `/connections/:id/buckets`                          | List buckets                                 |
| `POST`   | `/connections/:id/buckets`                          | Create bucket                                |
| `DELETE` | `/connections/:id/buckets/:bucket?force=`           | Delete bucket (`force` empties it first)     |
| `GET`    | `/connections/:id/buckets/:bucket/objects?prefix=&token=` | One page of folders + objects        |
| `GET`    | `/connections/:id/buckets/:bucket/object?key=`      | Stream an object down                        |
| `PUT`    | `/connections/:id/buckets/:bucket/object?key=&contentType=` | Stream a raw body up                 |
| `POST`   | `/connections/:id/buckets/:bucket/folder`           | Create a folder marker                       |
| `POST`   | `/connections/:id/buckets/:bucket/rename`           | Copy + delete one object                     |
| `DELETE` | `/connections/:id/buckets/:bucket/object?key=&recursive=` | Delete an object or a whole prefix     |

### 4.5 Secrets Vault (`/server/vault`)

- Wraps libsodium.
- Master key sourced from `SMT_ENCRYPTION_KEY` (env var or file).
- Per-record nonces; AAD includes resource id and type to prevent ciphertext swapping.
- Key rotation supported via versioned envelope encryption.

### 4.6 AI Gateway (`/server/ai`)

- Single internal interface:
  ```ts
  interface AIProvider {
    chat(messages: Message[], opts?: ChatOptions): AsyncIterable<Token>;
  }
  ```
- Built-in adapters: `OpenAIProvider`, `AnthropicProvider`, `OpenAICompatibleProvider` (covers Ollama, LM Studio, vLLM, llama.cpp server, etc.).
- All requests proxied through the server so the browser never holds API keys.

### 4.7 Audit Logger (`/server/audit`)

- Append-only table with: actor, action, resource, before/after diff (redacted), IP, user agent, timestamp.
- Hooked at the API layer via Fastify plugins.

---

## 5. Data Model (Logical)

```
Organization 1───* User
Organization 1───* Membership *───1 Role
Organization 1───* SSHKey
Organization 1───* Server *───* Tag
Server       1───* SavedCommand
Server       1───* CronJob
CronJob      1───* CronRun
Server       1───* SSHSession (live, ephemeral)
Server       1───* ServerMetric
Server       1───1 ServerHealth
Server       1───* ServerAlert
Organization 1───* AIProviderConfig
Organization 1───* StorageConnection
Organization 1───* AuditLogEntry
User         1───* APIToken
```

### Key tables

- **organizations** — root tenant scope inside an instance.
- **users** — global; can belong to multiple orgs.
- **memberships** — `(user_id, org_id, role)`. Role is one of `owner | admin | operator | viewer`.
- **ssh_keys** — `name`, `type`, `public_key`, `encrypted_private_key`, `key_version`, `created_by`.
- **servers** — `name`, `host`, `port`, `username`, `default_key_id`, `tags[]`, `notes`.
- **saved_commands** — `server_id` (nullable for org-wide), `name`, `command`, `variables jsonb`, `category`.
- **cron_jobs** — `server_id`, `command_id` or inline `command`, `schedule` (cron), `timezone`, `enabled`, `next_run_at`, `notify jsonb`.
- **cron_runs** — `cron_job_id`, `started_at`, `finished_at`, `exit_code`, `stdout`, `stderr`, `status`.
- **server_metrics** — append-only health samples: `status`, `latency_ms`, `uptime_seconds`, load, CPU jiffies + percent, memory, swap, disk, `disks jsonb`, `error`. Pruned on a retention window.
- **server_health** — one row per server holding its current state, so list views never scan the time series.
- **server_alerts** — one row per alert occurrence; `resolved_at` is set when the condition clears, `acknowledged_at` when a user silences it.
- **ai_provider_configs** — `provider`, `base_url`, `model`, `encrypted_api_key`, `default boolean`.
- **storage_connections** — `name`, `provider` (`s3 | minio | other`), `endpoint` (null = AWS), `region`, `access_key_id`, `encrypted_secret_access_key`, `force_path_style`, last-test status.
- **audit_log** — append-only, partitioned by month.
- **sessions** — browser auth sessions (Lucia).
- **api_tokens** — programmatic access tokens, scoped + hashed.

### Encrypted columns

`ssh_keys.encrypted_private_key`, `ai_provider_configs.encrypted_api_key` and `storage_connections.encrypted_secret_access_key` are encrypted with the vault. Plaintext exists only transiently in process memory during use.

---

## 6. Key Flows

### 6.1 Open an interactive SSH session

```
Browser                API                    SSH Broker        Server
   │  POST /sessions      │                       │                │
   ├─────────────────────►│ create session row    │                │
   │  {sessionId, wsUrl}  │                       │                │
   │◄─────────────────────┤                       │                │
   │  WS connect (sid)    │                       │                │
   ├─────────────────────►│ authz check           │                │
   │                      ├──────────────────────►│ load + decrypt │
   │                      │                       │  key           │
   │                      │                       ├───────────────►│ SSH+pty
   │  xterm frames        │  bidirectional        │  bidirectional │
   │◄════════════════════►│◄═════════════════════►│◄══════════════►│
   │                      │                       │                │
   │  WS close            │ mark session ended    │ close channel  │
   ├─────────────────────►│ audit log entry       │                │
```

### 6.2 Run a saved command

1. User clicks **Run** on a saved command.
2. API enqueues an immediate one-shot job in BullMQ.
3. Worker opens an `exec` channel via SSH Broker, streams output.
4. Output streamed live to browser via Redis pub/sub → WebSocket.
5. Final result written to `command_runs` and audit log.

### 6.3 Scheduled cron job

1. On create/update, API computes `next_run_at` using the cron expression + timezone.
2. A repeatable BullMQ job (or polling tick) enqueues runs at the right time.
3. Worker executes the run identically to a saved command.
4. On failure, optional notification (webhook / email / Slack).
5. UI shows run history with timing, exit code, and full output.

### 6.3b Health check sweep

```
interval tick
  → select servers where monitoring_enabled
  → bounded-concurrency pool
      → resolve + decrypt credentials
      → short-lived SSH connect, run probe script, disconnect
      → parse sample, compute CPU delta vs previous sample
      → insert server_metrics row, upsert server_health row
      → evaluate thresholds → open / refresh / resolve server_alerts
  → hourly: prune samples past the retention window
```

Servers with monitoring switched off move to `paused` instead of being skipped
silently, so the UI can tell "not checked" apart from "not watched".

### 6.4 AI chat (BYO model)

1. User opens AI panel and asks a question (with optional context: server, last output).
2. API loads org's AI provider config, decrypts API key in memory.
3. API streams from provider via SSE/stream → WebSocket → browser.
4. AI responses are never persisted unless the user saves them.

---

## 7. Security Model

### Encryption at rest

- All sensitive fields encrypted with libsodium `crypto_aead_xchacha20poly1305_ietf`.
- Master key from `SMT_ENCRYPTION_KEY` (32 bytes, base64). Operators are responsible for backing this up.
- AAD binds ciphertext to `(table, row_id, field, key_version)` to prevent swap attacks.
- Key rotation: new `key_version` introduced; background job re-encrypts.

### Authentication

- Built-in email + password (Argon2id hashing).
- OAuth/OIDC (Google, GitHub, GitLab, generic OIDC).
- Optional TOTP 2FA.
- Session cookies: `HttpOnly`, `Secure`, `SameSite=Lax`, rotating on privilege change.

### Authorization (RBAC)

Enforced by `requireRole(minimum)` in `/server/auth/middleware.ts`, applied per route.
Roles are totally ordered — `viewer < operator < admin < owner` — and each implies
every role before it. An unrecognized role string degrades to `viewer`, never upward.

| Area                        | Read     | Write / run |
| --------------------------- | -------- | ----------- |
| Servers                     | viewer   | admin       |
| SSH keys                    | viewer   | admin       |
| AI providers                | viewer   | admin       |
| Audit log                   | admin    | —           |
| Saved commands              | viewer   | operator (delete: admin) |
| Cron jobs                   | viewer   | operator    |
| SSH sessions (terminal)     | —        | operator    |
| SFTP list / download / read | viewer   | —           |
| SFTP upload / mkdir / rename / delete | — | operator |
| Storage connections         | viewer   | admin       |
| Buckets (create / delete)   | viewer   | admin       |
| Objects list / download     | viewer   | —           |
| Objects upload / folder / rename / delete | — | operator |
| AI chat                     | —        | operator    |

Two deliberate departures from a naive reading of "viewer = read-only":

- **Opening an interactive session is `operator`, not `viewer`.** A shell is arbitrary
  code execution; granting it to viewers would make the role meaningless.
- **AI chat is `operator`.** The agent exposes a `run_command` tool, so chat access is
  transitively command execution.

The UI hides controls the caller cannot use (`useHasRole` in `/web/store/auth.ts`), but
that is cosmetic only — every rule above is enforced server-side and independently.

Not yet implemented: per-resource ACLs overriding role defaults, and member-management
routes (invite / role change / remove), which is why `owner` currently grants nothing
beyond `admin`.

### Network

- All browser ↔ server traffic expected over TLS via reverse proxy.
- WebSocket origins validated against `SMT_BASE_URL`.
- Outbound SSH locked to user-supplied hosts; optional allowlist.
- No outbound calls except to the configured AI provider.

### Audit & Tamper-evidence

- Append-only audit log. Optional periodic hash chaining for tamper detection.
- Sensitive payloads (key material, AI prompts) redacted in logs.

### Threat model highlights

- **Compromised browser session** → bounded by RBAC + 2FA + short session TTL + audit.
- **Compromised DB dump** → useless without `SMT_ENCRYPTION_KEY`.
- **Malicious AI provider** → keys stay server-side; prompts are user-initiated; no automatic execution of AI-generated commands without explicit user confirmation.

---

## 8. Deployment Topologies

### Solo / small team (default)

- 1 container: API + Worker in-process.
- SQLite + filesystem volume.
- No Redis (in-memory queue).

### Team / production

- 2 containers: `api`, `worker`.
- Postgres + Redis.
- Reverse proxy with TLS.
- Backup: nightly Postgres dump + `SMT_ENCRYPTION_KEY` stored separately.

### High availability (optional)

- N × `api`, N × `worker` behind a load balancer with sticky sessions for WebSockets.
- Managed Postgres + managed Redis.
- Shared object storage for large run logs (S3-compatible).

---

## 9. Distribution

- **Docker images** published to GHCR for `linux/amd64` and `linux/arm64`.
- **`docker-compose.yml`** included in the repo for one-command setup.
- **Single binary** built with Bun (or `pkg`) for `darwin/linux/windows`.
- **Helm chart** (later) for Kubernetes operators.
- **Reproducible builds** via pinned lockfiles and a `Dockerfile` using distroless base.

---

## 10. Repository Layout

```
server-management-tool/
├── apps/
│   ├── web/              # React frontend (Vite + TS)
│   └── server/           # Fastify API + worker entrypoints
│       ├── src/
│       │   ├── api/      # HTTP + WS routes
│       │   ├── worker/   # BullMQ processors
│       │   ├── monitoring/ # Agentless SSH health checks + alerting
│       │   ├── ssh/      # SSH broker
│       │   ├── storage/  # S3 / MinIO client + ops
│       │   ├── ai/       # AI provider adapters
│       │   ├── vault/    # Secrets encryption
│       │   ├── audit/    # Audit logging
│       │   ├── auth/     # Lucia, OAuth, RBAC
│       │   ├── db/       # Drizzle schema + migrations
│       │   └── config/   # Env + runtime config
│       └── tests/
├── packages/
│   ├── shared/           # Types shared between web and server
│   └── cron-parser/      # Vendored / wrapped cron utilities
├── deploy/
│   ├── docker/           # Dockerfile, compose, healthchecks
│   └── helm/             # (future) Kubernetes chart
├── docs/
│   ├── ARCHITECTURE.md   # this file
│   ├── SECURITY.md
│   └── CONTRIBUTING.md
├── scripts/              # Build, release, migration helpers
└── README.md
```

---

## 11. Configuration

All configuration is via environment variables. Sensible defaults are provided.

| Variable                 | Required | Description                                                   |
| ------------------------ | -------- | ------------------------------------------------------------- |
| `SMT_BASE_URL`           | yes      | Public URL of the instance (used for WS origin checks, OAuth) |
| `SMT_ENCRYPTION_KEY`     | yes      | 32-byte base64 master key for the secrets vault               |
| `SMT_DB_URL`             | no       | Postgres URL. Defaults to SQLite at `/data/smt.db`            |
| `SMT_REDIS_URL`          | no       | Redis URL. Defaults to in-memory queue (single-node only)     |
| `SMT_SESSION_SECRET`     | yes      | Cookie signing secret                                         |
| `SMT_OAUTH_*`            | no       | Per-provider OAuth client configuration                       |
| `SMT_LOG_LEVEL`          | no       | `info` (default), `debug`, `warn`, `error`                    |
| `SMT_MAX_SSH_SESSIONS`   | no       | Per-user concurrent SSH session cap                           |
| `SMT_AI_REQUEST_TIMEOUT` | no       | Timeout for outbound AI calls (ms)                            |
| `SMT_SFTP_MAX_UPLOAD_BYTES` | no    | Max SFTP upload size in bytes (default 1 GiB)                 |
| `SMT_STORAGE_MAX_UPLOAD_BYTES` | no | Max object-storage upload size in bytes (default 5 GiB)       |
| `SMT_MONITORING_ENABLED` | no       | Run agentless health checks (default `true`)                  |
| `SMT_MONITORING_INTERVAL` | no      | Seconds between health sweeps (default 60, minimum 15)        |
| `SMT_MONITORING_CONCURRENCY` | no   | Servers probed in parallel (default 5)                        |
| `SMT_MONITORING_TIMEOUT` | no       | Per-check SSH timeout in ms (default 20000)                   |
| `SMT_MONITORING_RETENTION_HOURS` | no | How long metric samples are kept (default 168)              |
| `SMT_ALERT_*_PERCENT`    | no       | CPU / memory / disk alert thresholds (default 90 each)        |
| `SMT_ALERT_LOAD_PER_CORE` | no      | Load-average alert threshold, per core (default 2)            |
| `SMT_ALERT_OFFLINE_FAILURES` | no   | Failed checks before a host is alerted as down (default 2)    |
| `SMT_SMTP_URL`           | no       | `smtp://` or `smtps://` URL; enables email alert channels     |
| `SMT_SMTP_FROM`          | if SMTP  | Sender address for alert emails                               |
| `SMT_CLOUD_SYNC_ENABLED` | no       | Run the scheduled cloud inventory sync (default `true`)       |
| `SMT_CLOUD_SYNC_INTERVAL` | no      | Minutes between cloud syncs (default 15, minimum 5)           |
| `SMT_CLOUD_REQUEST_TIMEOUT` | no    | Per-request provider timeout in ms (default 30000)            |

---

## 12. Observability

- **Structured logs** (JSON, pino).
- **Metrics** exposed on `/metrics` (Prometheus format): HTTP, WS, queue depth, SSH session counts, AI latency.
- **Health endpoints**: `/healthz` (liveness), `/readyz` (DB + Redis check).
- **Tracing** (optional): OpenTelemetry exporter.

---

## 13. Extensibility

Three primary extension points:

1. **AI providers** — implement `AIProvider` and register in the provider registry.
2. **Notification channels** — implement `Notifier` (`webhook`, `email`, `slack` ship by default).
3. **Auth providers** — add an OIDC config entry; custom providers via a small adapter.

A future plugin system will allow loading these from external packages without forking.

---

## 14. Open Questions / Future Work

- Live shared terminal sessions (multi-user attach to one PTY).
- SFTP / file browser inside the UI.
- Fan-out command execution across server groups with structured aggregation.
- Lightweight server-side agent (optional) for richer telemetry without polling.
- End-to-end encrypted secret sharing between teammates.
- Plugin marketplace.

---

## 15. Glossary

- **SMT** — Server Management Tool.
- **Org** — Organization; the top-level scope of users and resources within an instance.
- **Vault** — The libsodium-based encryption layer for secrets at rest.
- **Run** — A single execution of a saved command or cron job.
- **BYO AI** — Bring Your Own AI; operator-chosen AI provider.
