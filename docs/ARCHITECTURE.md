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
Organization 1───* AIProviderConfig
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
- **ai_provider_configs** — `provider`, `base_url`, `model`, `encrypted_api_key`, `default boolean`.
- **audit_log** — append-only, partitioned by month.
- **sessions** — browser auth sessions (Lucia).
- **api_tokens** — programmatic access tokens, scoped + hashed.

### Encrypted columns

`ssh_keys.encrypted_private_key` and `ai_provider_configs.encrypted_api_key` are encrypted with the vault. Plaintext exists only transiently in process memory during use.

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
│       │   ├── ssh/      # SSH broker
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
