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

- `providers/{aws,gcp,azure,digitalocean,hetzner}.ts` — one adapter per provider,
  each with a pure `toInstance()` mapper from the provider's wire shape to a
  normalised `CloudInstance` (id, name, region, running/stopped/other, public and
  private IP, tags, instance type). AWS uses `@aws-sdk/client-ec2`; GCP signs an
  RS256 service-account JWT with Node `crypto` and pages the aggregated instances
  list; Azure exchanges a service-principal secret for a token and runs one Resource
  Graph query that joins VMs, NICs and public IPs; DigitalOcean and Hetzner are one
  paginated `fetch` each. Short-lived tokens sit in a `TokenCache` refreshed five
  minutes early. Errors become a `CloudError` carrying an HTTP status (403 for
  rejected credentials or missing roles, 504 for timeouts, 502 otherwise).
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
organisation, filtered by minimum severity and the resolve opt-in. Each channel
type is a `ChannelAdapter` in `notifications/channels/`: `prepare()` validates the
form input and packs it into the single vault-encrypted target string (plus a masked
hint), `build()` turns an event into the outbound request. Types: `slack`
(also Mattermost), `discord`, `teams` (Adaptive Card), `googlechat`, `telegram`,
`ntfy`, `gotify`, `pushover`, `pagerduty` and `opsgenie` (open/resolve keyed on
`smt:<serverId>:<alertType>`; a test triggers then resolves), `webhook` (structured
JSON) and `email` (SMTP via nodemailer, configured instance-wide by `SMT_SMTP_URL`
/ `SMT_SMTP_FROM`). `user:pass@` in a URL becomes an HTTP Basic header. Delivery is
fire-and-forget with one retry; a 4xx is final.

### 4.3e DNS Lookup (`/server/dns`)

Stateless: no table, no credentials, one read-only endpoint. `domain.ts` reduces
whatever was pasted (a URL, a trailing dot, a unicode name, a port) to the
lowercase punycode form, rejecting anything that is not a domain, and owns the
private-address guard. `records.ts` runs one query per record type through
`node:dns`, treating an empty answer as an empty set rather than a failure.
`propagation.ts` repeats the A lookup against a **fixed** list of public
resolvers and reports which answers differ from the majority. `index.ts` ties
them together and labels record values that match a server's host.

Two guards matter. The resolver list is fixed, so a caller cannot aim the
endpoint at an arbitrary host on port 53; and a nameserver's own address comes
from the domain under test, so it is checked against loopback, private,
link-local, CGNAT and unique-local ranges before anything is sent to it.

### 4.4 SSH Broker (`/server/ssh`)

- Wraps `ssh2`. Responsibilities:
  - Decrypt key material on demand (never persisted in plaintext, never logged).
  - Open interactive shells, exec channels, and SFTP channels.
  - Bridge a `pty` to a WebSocket frame stream.
  - Enforce per-connection limits and timeouts.

#### Jump hosts (`/server/ssh/jump.ts`)

- A server may name another server in the same org as its jump host (`servers.jump_server_id`,
  like `ssh -J`). Every connection path — terminal, one-shot exec (AI, saved commands, cron),
  the SFTP pool, health probes and host key scans — goes through `connectSsh`, which connects
  to the jump host with **its own** credentials and host key check, opens a `direct-tcpip`
  channel to the target's host:port, and runs the target's handshake over it with the
  target's own host key check. Jump connections close with the target connection.
- Chains are same-org, loop-free and at most 3 hops; the API refuses anything else and the
  connect path re-checks. Deleting a jump host makes the servers behind it direct again.
- **Access decision:** using a server through its jump host does not require access to the
  jump server. The route is part of how an admin configured the target (like its stored
  credentials), and the user only gets a channel to the target — never a shell or files on
  the jump host. Only admins set jump hosts. Each hop is audited as `server.jump` on the
  jump server, attributed to the user the connection is for (background health checks only
  log it, to keep the audit log readable).
- **Errors at a hop** (unreachable, refused login, changed host key) name the jump host, so
  they are only returned as-is to someone who may access the jump server (`canAccessServer`:
  admins, or members granted it). Everyone else — and background work with no user, whose
  errors are stored in health samples members can read — gets `The route to this server
  failed at hop N` (hops counted from the app outwards). The full error is always logged.

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

### 4.4c FTP (`/server/ftp`)

Plain FTP and FTPS for the hosts that only offer that: shared hosting, cPanel,
appliances, legacy boxes. Built on `basic-ftp`, which handles explicit TLS
(`AUTH TLS` on port 21), implicit TLS (conventionally port 990), passive mode
and both Unix and MLSD listing formats.

- `paths.ts` — pure helpers: absolute POSIX path normalisation (`..` collapses
  rather than escaping, no null bytes or line breaks, since a path is spliced
  into a control-channel command), plus the host guard (a hostname or IP, not a
  URL; metadata addresses refused).
- `errors.ts` — maps FTP reply codes onto HTTP statuses. `550` is overloaded in
  the protocol, so the server's own wording decides between 404 and 403.
  Socket failures and the client's inactivity watchdog become 502 / 504.
- `client.ts` — builds the access options (TLS mode, certificate verification)
  and logs in.
- `ops.ts` — thin wrappers over the client: listing (directories first, mode
  bits rendered as `rwxr-xr-x` when the server reports them), a `stat` built
  from listing the parent (FTP has no stat; `SIZE` and `MDTM` are optional
  extensions), mkdir, rename, single and recursive delete, streamed upload and
  download, and the connection test.
- `index.ts` — resolves a connection for the caller's org, decrypts the
  password, and keeps one logged-in client per `orgId:connectionId:userId`.

The pool matters more here than for S3: an FTP control connection runs one
command at a time, so each pooled client carries a promise chain that
serialises the operations queued against it. A failure that is not a plain FTP
reply — a dropped socket, a timeout, an aborted transfer — leaves the control
connection in an unknown state, so the client is closed and the next call
reconnects. Idle clients close after two minutes; editing or deleting a
connection evicts its clients immediately.

Downloads list the parent first so a missing path is a clean 404 rather than a
broken stream after the headers have gone out, then pipe the data connection
straight to the response. Uploads pipe a raw `application/octet-stream` body
to the server, capped by `SMT_FTP_MAX_UPLOAD_BYTES`. `.` as a path opens the
connection's configured start directory, else the login directory.

REST surface, all under `/api/ftp`:

| Method   | Path                                   | Purpose                                      |
| -------- | -------------------------------------- | -------------------------------------------- |
| `GET`    | `/connections`                         | List connections (password never returned)   |
| `GET`    | `/connections/:id`                     | One connection                               |
| `POST`   | `/connections`                         | Create (port defaults per protocol)          |
| `PATCH`  | `/connections/:id`                     | Update (omit `password` to keep it)          |
| `DELETE` | `/connections/:id`                     | Delete                                       |
| `POST`   | `/connections/:id/test`                | Log in and list the login directory, result recorded |
| `GET`    | `/connections/:id/list?path=`          | Directory listing (`.` = start directory)    |
| `GET`    | `/connections/:id/download?path=`      | Stream a file to the client                  |
| `PUT`    | `/connections/:id/file?path=`          | Upload a raw body to that path               |
| `POST`   | `/connections/:id/mkdir`               | Create a directory                           |
| `POST`   | `/connections/:id/rename`              | Rename or move                               |
| `DELETE` | `/connections/:id/file?path=&recursive=` | Delete a file, an empty directory, or a tree |

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
- **Retention** (`retention.ts`) — a daily in-process job deletes each org's rows older than
  its retention (default 365 days, 7–3650), in chunks, and records `audit.pruned`.
- **Forwarding** (`forward.ts`) — one target per org: syslog (RFC 5424 over UDP, TCP or TLS
  with octet-counted framing) or a webhook (JSON batches, optional HMAC signature). A 10 s
  in-process tick sends rows older than a 15 s settle window in batches of 200; the cursor
  only moves past accepted rows (at-least-once), and a failing target backs off from 30 s to
  15 min. Targets are encrypted in the vault and must resolve to public addresses unless
  `SMT_AUDIT_FORWARD_ALLOW_NETS` allows an internal network (metadata addresses never).
- Noisy events are capped rather than dropped silently: repeated host key mismatches for the
  same key write one row per 10 minutes carrying a `suppressed` count. Read-only list views
  (e.g. the backup list, which the page refetches) are not audited.

### 4.8 App Database Backups (`/server/backup`)

- `core.ts` — online backups with better-sqlite3's `db.backup()` (SQLite backup API, consistent under WAL and concurrent writes), written as `.partial` then renamed; `sessions` and `webauthn_challenges` are emptied and invite tokens replaced with `secure_delete` in the copy; optional gzip; per-reason retention (`SMT_BACKUP_KEEP`). No config/logger imports, so the CLIs can use it with a bare environment.
- `scheduler.ts` — in-process interval (like health checks and cloud sync); a backup is due when the newest `scheduled` one is older than `SMT_BACKUP_INTERVAL_HOURS`.
- `db/migrate.ts` — before drizzle applies a pending migration to a non-empty database, a `pre-migration` backup is taken; failure aborts startup.
- `lock.ts` — the server writes `<db>.lock` and touches it every 30 s; `cli/restore.ts` refuses while it is fresh (works across Docker pid namespaces), while its pid is alive on this host, or while the port answers.
- `upload.ts` — optional copy to a registered object-storage connection via `storage/ops.putObject`, encrypted (AES-256-GCM, key derived from `SMT_ENCRYPTION_KEY`, `crypt.ts`) since the bucket is browsable by the connection's org members.
- API: `GET/POST /api/admin/backups`, `GET /api/admin/backups/:name/download` — owner of the instance's first organization only; download needs a browser session plus passkey step-up; names must match the generated pattern exactly. Creating, downloading and failures are audited (`backup.create`, `backup.download`, `backup.failed`, `backup.upload_failed`); listing is not.
- Session recordings (files under `SMT_RECORDINGS_DIR`) are not part of these backups.

### 4.9 Connectivity Diagnostics (`/server/diagnostics`)

- `run.ts` runs ordered steps and stops at the first failure: DNS, TCP, TLS or the
  protocol banner, the host key against the pinned one, and optionally a login with the
  stored credentials. Each failed step carries a remediation (`remediation.ts`), including
  firewall rules with the app's egress IP (`egress.ts`, `SMT_EGRESS_IP[_SERVICES]`).
- `targets.ts` adapts servers, FTP/SFTP and storage connections. Behind a jump host the
  network steps probe the first hop and the host key/login go through the chain; behind an
  agent they run over its tunnel. A presented key that does not match is only revealed to
  admins.
- Operator and up, per-server access applies, audited (`*.diagnose`), 10 runs a minute per user.

### 4.10 Access Requests / JIT Access (`/server/auth/access-grants.ts`, `api/routes/access-requests.ts`)

- Restricted members request servers for a reason and a duration (org maximum, 8 h by
  default); at most 10 pending and 20 created per hour each; undecided requests lapse after
  3 days. Admins and owners are notified through the org's channels (as notices).
- An admin other than the requester approves (optionally for less time) or denies; the
  decision is conditional on the row still being pending, so two admins cannot both win.
  Approval refuses (409) a requester who has left or is suspended, re-checked inside the
  decision transaction; suspending or removing a member cancels their pending requests.
- Requests are resource-typed (`resource_type`): servers, or Kubernetes clusters
  (`clusterIds`, `GET /access-requests/clusters`); a cluster approval goes to
  `member_cluster_access` via `extendClusterGrants`.
- Approval writes time-bound rows in `member_server_access` via `extendGrants`, which never
  shortens existing access. `activeGrantFilter` ignores expired grants at once; a sweep
  every minute deletes them and closes terminals/SFTP/agent streams still open on them.

### 4.11 Session Recording (`/server/recordings`)

- Terminals and one-shot command runs are written as asciicast v2 (`recorder.ts`) under
  `SMT_RECORDINGS_DIR`, appended as they happen, capped at `SMT_RECORDING_MAX_BYTES` (a
  truncation marker is written), and gzipped at the end. Keystrokes only when the org opts in.
- Recording fails open: an unwritable directory leaves the session unrecorded and logs it.
- Admins see the org's recordings, others their own, never on a server they cannot access;
  views and downloads are audited; deletion is owner-only with passkey step-up. A daily
  job prunes past the org's retention (default 90 days).

### 4.12 Connectivity Agents (`/server/agents`, `packages/agent`)

- For servers without inbound SSH: a single-file Node agent under systemd dials the app
  (`SMT_BASE_URL`) over an outbound WebSocket and multiplexes TCP streams (`hub.ts`, at
  most 64 per agent, keepalive every 30 s). Only the app opens streams, and only to the
  agent's own loopback on its allowed ports; host keys are still verified end to end.
- Tokens (`bsa_…`) are shown once and stored as a SHA-256 hash. The install command
  downloads `install.sh` to a temp file and runs it as root with the token on **stdin** (a
  here-doc), never in a process's arguments; the script refuses to be piped into `sh`,
  checks the agent bundle's SHA-256, and writes the token to `/etc/bastion-agent/agent.env`
  (0600, in a 0700 directory), which the hardened unit (`DynamicUser`, `ProtectSystem=strict`)
  loads with `EnvironmentFile=`.
- A server uses a jump host or an agent, not both (a jump host may sit behind an agent).
  Revoking an agent drops its connection; its servers then fail closed. Agent connections
  live in the app process, so a separate worker cannot use them.

### 4.13 Single Sign-On (`/server/auth/sso.ts`, `sso-policy.ts`)

- Per-org OIDC (code flow + PKCE, `openid-client`); identities keyed by (provider, `sub`).
- An SSO session (`sessions.sso_provider_id`) only works in its provider's org. When the
  account belongs to other orgs too, it may not add account-wide credentials (passkeys,
  backup codes, API tokens), and `GET/DELETE /api/auth/sessions` show and end only SSO
  sessions of the same org (`manageableSessionsFilter`): the other org's IdP must not see
  or sign out password/passkey sessions (usable in any org) or other orgs' SSO sessions.
  A password or passkey session manages every session of the account.
- An org may enforce SSO: non-SSO sessions of members other than owners are refused
  (owners keep a break-glass way in); API tokens are unaffected.

### 4.14 SSH Key Rotation (`/server/ssh/key-rotation.ts`)

- prepare → install the new key over the old one → verify a fresh login with the new key
  alone → switch the server → remove the old key's lines over the new one → retire the old
  key once nothing uses it. Any failure rolls back; the server never points at a key it
  does not accept. authorized_keys is edited by small POSIX scripts sent on stdin.
- Admin-only with passkey step-up; steps are kept in the rotation history and audited,
  including jump hops under the admin who asked. Other servers logging in to the same
  account (host, port, user — behind an agent, the agent stands in for the host) with the
  old key share its authorized_keys, so the old line is left there and the key not retired.

### 4.15 Docker (`/server/docker`, `api/routes/docker.ts`)

Design: `docs/superpowers/specs/2026-09-30-docker-management-design.md`. Phases D1 (read),
D2 (actions), D3 (exec), D4 (Compose) and D5 (AI tools, container alerts, fleet view) are in place.

- **Transport** (`transport.ts`): no Docker client library and no second SSH path. Over a
  pooled ssh2 connection built with `sshConnectConfig` + `connectSsh` (so host keys, jump
  hosts and agents apply), each HTTP connection to the daemon gets a fresh
  `direct-streamlocal@openssh.com` channel to the socket, or an exec channel running
  `docker --host unix://<socket> system dial-stdio` where sshd refuses socket forwarding.
  The dial-stdio stream reports the CLI's stderr when it exits early.
- **Pool** (`pool.ts`): one SSH connection per (org, server, user), closed after 2 idle
  minutes, evicted by `revokeLiveAccess` (with the user's Docker event streams) and when a
  server is edited, deleted, its host key changes or its key is rotated. Demoting a
  member ends their open Docker streams, since logs and stats are gated by role when a
  stream opens.
- **Client** (`client.ts`): `http.request` with an `Agent` whose `createConnection` opens
  the stream; JSON calls with a timeout and body cap, streaming calls (logs, stats,
  events), and hijacked calls (`Upgrade: tcp`, for exec). Paths are versioned with the
  API version negotiated from `/version` — the newest both sides speak, 1.25 to 1.47 —
  and pinned on the server row.
- **Detection** (`probe.ts`): on demand only (an admin's probe, or the first request for a
  server not yet detected). Streamlocal to the configured or default socket first; if that
  fails, one POSIX script (run via `sh -c`, arguments quoted) reports the CLI, the runtime
  directory and which candidate sockets exist and are usable — default, rootless
  (`$XDG_RUNTIME_DIR/docker.sock`), Podman (`/run/podman/podman.sock`, and the rootless
  one). A usable socket that sshd will not open a channel to means forwarding is off
  (OpenSSH answers a bare "open failed" under `AllowTcpForwarding no` too), and dial-stdio
  is tried. The result — transport, socket, engine and API version — is stored on
  `servers` (`docker_*` columns); a failure clears it and names the problem and fix.
  The Diagnose flow runs the same probe (without recording) after a successful login.
- **Routes** (`/api/docker`): `withDockerClient(req, serverId, fn)` (`service.ts`) is the
  only way in — per-server access (404), Docker off (400), lease, lazy detection, client.
  Read routes: containers, inspect (Env values redacted by `redact.ts`), top, images,
  image inspect, volumes, networks, info + `/system/df`, and SSE streams for logs (demuxed
  by `demux.ts`, tail ≤ 10 000, plus a streamed plain-text download), stats and engine
  events. Streams follow the AI chat's conventions (`sse.ts`): heartbeats, the daemon
  request aborted when the browser leaves, backpressure, at most 8 per user, ended with
  an `error` event on revocation. Ids and image references are validated
  (`validation.ts`) and path segments encoded.
- **Permissions** (`permissions.ts`, matrix in `@smt/shared` `dockerPermissions`):
  viewers list; operators also read logs, stats, top and inspect; exec and removal for
  operators follow the org's `docker_settings`; prune, env reveal and per-server settings
  are admin. Org settings are read by any member and changed by admins
  (`org.docker_settings`); probes are audited as `docker.probe`, reads are not.
- **Actions** (`api/routes/docker-actions.ts`, helpers in `actions.ts`): container
  start/stop/restart/kill/pause/unpause (Docker's 304 "already in that state" answers
  `{ changed: false }`), remove, image pull (`POST /images/create` streamed as SSE `pull`
  events; the reference validated and split into `fromImage` + tag or digest, never "all
  tags"; leaving cancels it), image remove, prune (containers, networks, volumes, images in
  `docker system prune` order; dry run from `/system/df` + `/networks`, which knows that
  volume prune spares named volumes from API 1.42), and env reveal — admin, browser session,
  passkey step-up required outright (`DOCKER_REVEAL_NEEDS_PASSKEY` without one). Each is
  audited against the server (`docker.container_*`, `docker.image_pull` with its outcome,
  `docker.image_remove`, `docker.prune` with what was reclaimed — also after a partial
  failure — and `docker.env_reveal` with variable names only).
- **Exec** (`exec.ts`, `api/routes/docker-exec.ts`): `POST …/containers/:cid/exec` checks
  the container runs, picks `/bin/bash` or `/bin/sh` (a detached `<shell> -c 'exit 0'` must
  exit 0; recent engines refuse the start with a 400 when the binary is missing), creates a
  TTY exec (`ConsoleSize` from API 1.42, plus `/exec/:id/resize`) and hijacks its start.
  `execChannel` shapes the raw stream (demuxed without a TTY) like an ssh2 shell channel,
  and `SSHBroker.adoptSession` registers it: the browser attaches over
  `/api/ssh-sessions/:id/ws`, and buffering, reaping, recording (kind `container`, the
  container named in `command` as `name (id12)`), `closeForUser` on revocation and
  `DELETE /api/ssh-sessions/:id` all come from the broker. The route holds the pooled SSH
  lease for the shell's life. Closing writes ^C ^D and half-closes stdin — dropping the
  attach alone would leave the process running in the container — then records the exit
  code (`docker.exec_start` / `docker.exec_end`). `closeDisallowedExecSessions` ends
  container shells whose owner lost `exec` (demotion, `operatorsCanExec` switched off); the
  WebSocket re-checks `exec` on re-attach.
- **Compose** (`compose.ts`, `api/routes/docker-compose.ts`, phase D4): the Engine API has
  no Compose endpoints. Projects are discovered from container labels
  (`com.docker.compose.project`, `.service`, `.project.working_dir`,
  `.project.config_files`, `.container-number`; one-off `run` containers skipped), so a
  project taken `down` is no longer listed. Actions — only `up --detach`, `down`, `pull`,
  `restart` — run the CLI on an exec channel of the caller's pooled connection:
  `sh -c 'cd -- "$1" && shift && exec "$@"' sh <dir> env DOCKER_HOST=unix://<socket>
  docker compose --ansi=never --project-name=… --project-directory=… --file=… <verb>`.
  The script is constant; every label value is its own single-quoted argument
  (`shell.ts`), flags take their value after `=` so nothing becomes an option, project
  names must match Compose v2's pattern, and paths must be absolute with no control
  characters — otherwise the project is listed with the reason and actions answer 409.
  One action per (server, project) at a time. Output streams as SSE `logs` batches, then
  `exit` (code, signal, duration, timed out after 15 min). An action keeps running when
  the browser leaves; revocation evicts the connection and so ends it. Each is audited as
  `docker.compose_<verb>` with project, working dir, files and exit code (`null` when cut
  off). `GET compose/:project/logs` merges up to 32 containers' log streams into one SSE,
  each line tagged `source: "<service>-<n>"`, optionally one `service`. Listing is `view`,
  logs `inspect`, actions `pull` (operators and up).
- **Fleet view** (`fleet.ts`, `api/routes/docker-fleet.ts`): `GET /api/docker/containers
  ?serverIds&all` fans out over the accessible servers where Docker was detected (or the
  ids asked for, which detects them), five at a time, 10 s each through
  `withDockerClient`, and answers with partial results — one row per server, its error on
  that row — plus the servers skipped (Docker off, never detected). Ids the caller cannot
  access are left out silently. The browser leaving cancels requests in flight and the
  servers not yet asked. Web: the **Containers** page.
- **AI tools** (`ai-tools.ts`, `ai/tools.ts`): `docker_list_containers`,
  `docker_container_logs` (tail ≤ 500, no follow, newest 64 KB kept) and `docker_inspect`
  (always redacted) in `AGENT_TOOLS`, read-only, through `withDockerClient`; logs and
  inspect need the `inspect` capability from the caller's membership role. The chat route
  audits each call as `ai.docker_read` (tool, container, error — not the output), since it
  goes to the AI provider. Mutations stay on `run_command` and its approval.
- **Container alerts** (`monitoring/containers.ts`): opt-in per org
  (`docker_settings.containerAlerts`, default off). The health probe runs a follow-up on
  its own SSH connection (`runProbe(…, extra)`, 12 s, never fails the check) listing
  containers on servers with `docker_mode = 'auto'` that were detected — the sweep never
  detects. Only restarting, recently started and failed-exit containers are inspected
  (≤ 20 per sweep; restart policies cached, so an exited container whose policy and
  exit code are known is not inspected again). `container_unhealthy`,
  `container_restarting` (restart count +3 within 10 minutes, counted in memory across
  sweeps) and `container_exited` (non-zero, restart policy not `no`, SIGTERM/non-OOM
  SIGKILL ignored) are reconciled per (server, container name, type) — the name leads the
  message, as `server_alerts` has no container column — and host reconciliation leaves
  them alone. Notifications carry the container: titles and summaries name it
  (`Container exited (api)`), webhooks get `alert.container`, and paging dedup keys are
  per container.
  Turning the setting off, Docker off or pausing monitoring closes them silently; a sample
  that fails leaves them as they are.

### 4.16 Kubernetes (`/server/kube`, `api/routes/kube.ts`, `api/routes/kube-views.ts`)

Design: `docs/superpowers/specs/2026-10-03-kubernetes-visual-design.md`. Phase K1 (connect
and see: cluster map, namespaces, workloads, read-only details) is in place; K2–K5 (topology
graph and diagnoses, guided actions, logs and shells, AI and alerts) build on the helpers
below.

- **No kubectl, no client library.** The app speaks HTTP/1.1 to the API server itself
  (`client.ts`): `http.request` with an `Agent` whose `createConnection` hands every
  request a fresh, already verified TLS socket from `transport.ts`. Typed calls: `version`,
  `get`, `list` (follows `continue` tokens, 500 per page, capped), `watch` (newline-delimited
  events, `410 Gone` either as a thrown error or an `ERROR` event), `patch` (merge,
  strategic, JSON), `create`, `delete`, and `raw` for discovery, reviews and metrics. The
  `logs` and `exec` signatures are fixed for K4 and answer 501 until then. API errors keep
  the server's `Status.message`; 401 (credential refused) becomes a 502 naming the
  credential, 403 stays 403 (RBAC on the cluster said no), 429 becomes 503 (`errors.ts`).
- **Reaching the API server** (`transport.ts`), one of three routes per cluster:
  `direct` — the host is resolved here, every address checked with `blockedReason` (private
  ranges allowed as for servers; metadata and link-local refused) and the checked address
  dialled; `server` — `forwardOut` on a pooled SSH connection to a managed server
  (`ssh-pool.ts`: `sshConnectConfig` + `connectSsh`, so host keys, jump hosts and agents
  apply; one connection per (org, server), 2 idle minutes, evicted with the server's Docker
  and SFTP connections when it is edited, deleted, its host key changes or its key is
  rotated); `agent` — the connectivity agent's tunnel to a port on its own loopback (the
  agent must run on a control-plane node with the API port in `BASTION_ALLOWED_PORTS`).
  TLS then always runs end to end from this process: `tls.connect` over the raw stream with
  the cluster CA (or the system store), `rejectUnauthorized: true`, TLS 1.2+, the identity
  check and SNI against the API URL's host whatever the route (no SNI for IP literals, as
  TLS requires). A client certificate, when that is the credential, is presented here.
- **Kubeconfigs** (`kubeconfig.ts`, parsed with `yaml`, aliases capped): a context gives
  the server URL (https only, no credentials or query in it), the embedded CA, and a token
  or an embedded client certificate + key. Refused with a reason and what to do instead:
  `exec` and `auth-provider` users (they would run programs on the app host — the README
  shows how to create a service account token), `insecure-skip-tls-verify`, file paths
  (`certificate-authority`, `client-key`, `token-file`; flatten the file), basic auth,
  `proxy-url` and `tls-server-name`. `POST /api/kube/kubeconfig/contexts` lists the
  contexts with their problems for the picker; nothing is stored.
- **Storage** (`kube_clusters`, migration 0022): route, CA, `auth_type`, the credential
  (`token`, or `{cert, key}` JSON) encrypted with the vault under the row id and never
  returned — the UI gets `credential_hint` (`token ending …abcd`, `client certificate
  CN=…`) — impersonation flag, default namespace, namespace allowlist, last health
  (`last_status`, `last_error`, `last_checked_at`, `server_version`). An edit (or test)
  that changes `api_url` or `ca_data` must carry a new credential: the saved one is only
  sent to the API server it was saved for.
- **Access** (`auth/cluster-access.ts`, `service.ts`): clusters follow the per-server model.
  Owners and admins see every cluster; other members see every cluster unless their
  membership is `restricted`, then only the clusters in `member_cluster_access` (expiry
  respected at once, rows swept by the access-grant expiry job, which also ends what is
  open). `withKubeClient(req, clusterId, fn)` is the only way a route reaches a cluster: 404
  for a cluster outside the caller's org or grants, decrypts the credential, builds the
  client (with `Impersonate-User: bastion:<email>` / `Impersonate-Group: bastion:<role>` when
  the cluster has impersonation on), and passes the caller's permissions, org settings and
  the namespace allowlist (anything outside it is a 404). Grants are edited in the Team
  access dialog (`clusterIds`, `clusterExpiresInMinutes` on `PUT /api/team/members/:id/access`).
- **Watch cache** (`cache.ts`), informer-style: one list + watch per (cluster, resource,
  namespace scope) that someone is viewing, shared by all viewers (`subscribeKube` returns
  a refcounted subscription; `snapshotKube` reads several scopes for a JSON view). Watches
  resume from the last `resourceVersion` (bookmarks on), relist on `410 Gone`, keep the
  last objects and retry with backoff on other errors, and stop 2 minutes after the last
  viewer leaves. Objects are trimmed on the way in (no `managedFields`; Secrets stored
  already redacted). Each cluster is capped at 96 MB of cached objects; past it the
  least-viewed scope is dropped and its viewers told to narrow the namespace. With
  impersonation on the cache is per user and role, and `revokeLiveAccess` drops that
  user's caches as well as their streams. Editing or removing a cluster drops its caches
  and ends its streams (`resetCluster`).
- **Views** (`views.ts`, `health.ts`, `quantity.ts`, `metrics.ts`): `GET …/overview` is the
  cluster map — node cards (roles, Ready, cordoned, pressure conditions, allocatable vs
  summed pod requests, live usage from `metrics.k8s.io` when it answers — detected per
  cluster, remembered 5 minutes) with their pods as tiles (`running`, `pending`, `failing`,
  `completed`, `terminating`, with the most telling reason and restarts), and pods no node
  has taken with the scheduler's message. `…/namespaces`, `…/workloads?namespace&kind`
  (Deployments, StatefulSets, DaemonSets, Jobs, CronJobs with a health word and one-line
  summary), and `…/objects/:resource/:ns/:name` (`_` for cluster-scoped) — a fresh `get`,
  redacted, with facts, labels, health, related objects (owner chain up to the Deployment,
  owned ReplicaSets/Jobs, pods it owns, selects or runs); the read-only YAML is its own
  endpoint (below). What the credential may not list is left out with a plain-words warning
  instead of failing the view. Resources come from a fixed allowlist (`KUBE_RESOURCES` in
  `@smt/shared`), names and namespaces are checked against DNS-1123 before a path is built
  (`validation.ts`). `kubeObjectPath` / `kubeObjectUrl` give every object one stable URL,
  the same in the API and the web app.
- **Change feed** (`GET …/stream?view=overview|workloads|namespaces|object`, `sse.ts`,
  `api/sse.ts`): subscribes the view's scopes and sends `ready`, then `changed` (coalesced
  to one per 400 ms) — the browser refetches the view's JSON, so nothing large is pushed.
  Streams share Docker's machinery, now in `api/sse.ts`: heartbeats, cancellation when the
  browser leaves, at most 8 open streams per user across Docker and Kubernetes, and an
  `error` event + end on revocation. `kubeSseRoute` is the helper later phases (logs) use.
- **Redaction** (`redact.ts`): Secret `data`/`stringData` values become `••••` and the
  last-applied annotation (a copy of the manifest) is dropped, also inside `…List` objects;
  env vars from `secretKeyRef` show the reference only; ConfigMap values are shown unless
  the org turns `showConfigMapValues` off. Everything that leaves the server — details,
  YAML, and later AI context — goes through `redactObject`.
- **Permissions** (`permissions.ts`, matrix in `@smt/shared` `kubePermissions`, settings
  in `organizations.kube_settings`, defaults in `DEFAULT_KUBE_SETTINGS`): see the table in
  §7. `requireKube(capability)` is the route guard.
- **Test connection** (`connection-test.ts`, `POST …/clusters/test` before saving and
  `…/clusters/:id/test`): reach the port over the route → TLS → credential (`/api`) →
  `/version` → a `SelfSubjectRulesReview` in the default namespace summarized as the
  things BastionSSH uses (see pods, follow changes, read logs, scale, delete pods, exec,
  cordon, impersonate…). Admin only, rate-limited, audited (`kube_cluster.test`); a saved
  cluster's result sets its health dot.
- **Diagnose** (`diagnose.ts`): direct and agent routes run DNS, TCP and TLS (against the
  cluster CA) through the same diagnostics steps as servers; a server route runs the
  managed server's own steps (that is the hop the app makes). With login checks on, a
  final **Kubernetes API** step runs the connection test with the stored credential.
- **Understanding (K2)** (`graph.ts`, `health.ts`, `events.ts`, `insight.ts`,
  `api/routes/kube-graph.ts`), all read from the watch cache within the allowlist
  (`readObjects`), so each view is live through the change feed (`view=graph|events|attention`):
  - `GET …/graph?namespace=` — the app topology: Ingress → Service → Deployment /
    StatefulSet / DaemonSet / CronJob → Job → pods, with ConfigMaps, Secrets (name only),
    claims → volumes and autoscalers beside. Edges come only from real relationships: Ingress
    backends, Service selectors matched against pod labels (drawn to the owning workload, and
    to workloads whose template matches, so a scaled-to-zero Deployment still connects),
    ownerReferences (ReplicaSets fold into their Deployment), volume / `envFrom` /
    `valueFrom` references from templates and running pods, `volumeName`, `scaleTargetRef`.
    A workload's pods are one replica ring (counts per colour, ready/desired, up to 300 pods
    listed for expanding); more than 20 bare pods in a namespace share a ring. Edges that lead
    nowhere are `broken` with the reason in words — an Ingress to a missing Service, a
    Service no ready pod answers (a placeholder node when nothing matches its selector), a
    missing non-optional ConfigMap/Secret/claim, a claim's vanished volume, an autoscaler's
    missing target; a kind the credential may not list is never called missing.
  - **Diagnoses** (`health.ts` `diagnose`): spec §5.4's rules, each a headline, cause, next
    step and evidence (objects to open, events with counts, facts): image pull, OOMKilled
    (recent), crash loop (exit code and what it means; `…/insight` adds the previous run's
    last 20 log lines for members with the `logs` capability), unschedulable (needs vs the
    largest free node from allocatable minus requests; selector/taints; other), readiness
    probe failing (after the probe's own grace unless an `Unhealthy` event says so), Service
    without ready pods, claim pending (missing StorageClass, provisioning failure;
    `WaitForFirstConsumer` waits are not problems), node not ready / under pressure, rollout
    stuck (`ProgressDeadlineExceeded`, naming the new and still-serving ReplicaSets). One
    problem per pod, first rule wins. `GET …/attention` ranks them (critical, most
    affected, newest) and merges a workload's pods into one line (`mergeByOwner`).
  - `GET …/events?namespace=&since=` — Events grouped by involved object, newest first,
    repeats of one reason and message collapsed with summed counts (`series` and `count`
    understood); only plain fields leave the server.
  - `GET …/storage?namespace=` and `GET …/config?namespace=` (`inventory.ts`, the Storage and
    Config tabs) — claims with their volume, class, the §5.4 diagnosis of a pending one and
    who mounts them (template refs plus running pods attributed to their owning workload,
    so a StatefulSet's per-pod claims count towards it), storage classes, and volumes no
    visible claim holds (only without a namespace — a volume has none); ConfigMaps and
    Secrets as **key names only** with who reads them and how, plus required references
    to ones that do not exist (never when the kind could not be listed). Both follow the
    change feed (`view=storage|config`).
  - `GET …/objects/:resource/:ns/:name/insight` — the object's diagnoses (its own, its pods'
    through any controller, an Ingress's Services'), its events (a Deployment's include its
    ReplicaSets'), and the rollout timeline (Deployment: ReplicaSets as revisions with
    images and change-cause) or the pod lifecycle (Scheduled → Pulled → Started → Ready from
    conditions and events) and container lanes (init, app, sidecars).
  - Web: `AppsTab` lazy-loads `TopologyGraph` (`@xyflow/react`, laid out by `elkjs`'s
    layered algorithm, relaid only when the set of nodes or expanded rings changes);
    `ObjectInsight` sits in the object panel; `AttentionList` heads the Map tab.
- **Audit**: `kube_cluster.create/update/delete/test`, `kube_cluster.impersonation`,
  `org.kube_settings`, `kube.secret_view` (a Secret's redacted YAML was opened).
- **Guided actions (K3)** (`actions.ts`, `api/routes/kube-actions.ts`,
  `POST …/clusters/:id/actions/{scale,restart,rollback,delete-pod,cordon,uncordon,
  suspend-cronjob,trigger-cronjob}`): each a minimal, well-defined request — a merge patch
  of `{spec:{replicas}}` on the `scale` subresource; a strategic merge patch of the
  pod-template annotation `kubectl.kubernetes.io/restartedAt`; for a rollback a JSON patch
  that replaces `spec.template` with the revision's ReplicaSet template minus its
  `pod-template-hash` label and sets the annotations as `kubectl rollout undo` does,
  guarded by a `test` of the `resourceVersion` it read; `DELETE` of the pod; a merge patch
  of `spec.unschedulable` / `spec.suspend`; and for "run now" a Job created from the
  CronJob's `jobTemplate`, owned by it (`controller`, `blockOwnerDeletion`), marked
  `cronjob.kubernetes.io/instantiate: manual`, named `<cronjob>-manual-<5 hex>` (≤ 63).
  The patch bodies are pure functions with their own tests. Guards: the capability
  (`KUBE_ACTION_CAPABILITY` → `requireKube`, 403), then cluster access (404), name checks
  (400) and the namespace allowlist (404) before anything is sent. An object already in
  the asked state is answered `changed: false` with no write (audited with `changed: false`).
  A rollback refused by its `test` (the Deployment changed meanwhile) is a 409.
  `GET …/actions/preview/:resource/:ns/:name` gives the panels the current state —
  replicas, the HPA whose `scaleTargetRef` names the workload, the update strategy (so a
  restart of a `Recreate` / `OnDelete` workload is not described as one-by-one), a
  Deployment's revisions (image and env var *names* per container, never values), a pod's
  owner and whether deleting it brings a fresh one (not for a finished Job's), a node's pod
  count within the allowlist, a CronJob's schedule — and the actions the caller may take.
  `kubeActionCommand` (shared) renders the equivalent kubectl command for the "What this
  does" panel; nothing runs it. Audit: `kube.scale`, `kube.restart`, `kube.rollback`,
  `kube.delete_pod`, `kube.cordon`, `kube.uncordon`, `kube.cronjob_suspend`,
  `kube.cronjob_resume`, `kube.cronjob_trigger`, against the cluster with namespace,
  kind, name and before/after. The web components live in `components/kube/actions/`.
- **Inside a pod (K4, `api/routes/kube-pods.ts`).** `GET …/pods/:ns/:name` is the pod
  panel (`pods.ts`): containers as lanes (init → native sidecars, i.e. init containers
  with `restartPolicy: Always` → app → ephemeral) with state, restarts, last termination,
  requests/limits and usage from `metrics.k8s.io` (feature-detected), and a lifecycle
  strip from the pod's conditions. `GET …/logs` (operators, `logs.ts`) reads
  `…/pods/:name/log` and sends `ready` / `logs` batches / `end` over `kubeSseRoute` (same
  per-user cap and revocation as the change feed): one container at a time (the
  `kubectl.kubernetes.io/default-container` annotation, else the first app container),
  `previous` for the run before the last restart, tail capped at 10 000 lines, a followed
  stream ended with `truncated` after 64 MiB, 100 ms / 1 000-line batches, the API stream
  paused under browser backpressure; `…/logs/download` streams plain text (`limitBytes`
  32 MiB). Logs are not redacted (operator+, like Docker). `GET
  …/objects/:resource/:ns/:name/yaml` (operators) is the redacted YAML on its own, fetched
  when the tab opens.
- **Pod shells** (`websocket.ts`, `exec.ts`, `POST …/pods/:ns/:name/exec`): `client.upgrade`
  does the RFC 6455 handshake over a fresh socket from the cluster's transport (verified
  TLS, SNI, SSH `forwardOut` or agent tunnel — never the pooled agent's), offering
  `v5.channel.k8s.io` then `v4.channel.k8s.io`; `websocket.ts` frames it (masked client
  frames, fragments, ping/pong, close, 16 MiB message cap — no `ws` at runtime). Channels:
  0 stdin, 1 stdout, 2 stderr, 3 status (a `metav1.Status` with the exit code), 4 resize
  (`{"Width","Height"}`), 255 close (v5 only, ends stdin). The default command runs bash
  if present, else sh, in one exec. `podShellChannel` shapes it like an ssh2 shell channel
  and `SSHBroker.adoptSession` registers it with `pod: { clusterId, namespace, name,
  container }` and no server, so the terminal WebSocket, buffering, reaping and recording
  (kind `pod`, `serverId` null, `serverName` the cluster, `command`
  `namespace/pod/container`) are the broker's, as for Docker container shells. Closing
  writes ^C ^D, ends stdin (v5) and waits up to 3 s for the exit code
  (`kube.exec_start` / `kube.exec_end`). `closeForUser` takes `keepClusterIds`, so
  `revokeLiveAccess` keeps shells on clusters still granted; `closeDisallowedPodShells`
  ends shells whose owner lost `exec` (demotion, `operatorsCanExec` off) or the cluster,
  `closeClusterShells` those on an edited or removed cluster, and re-attaching to a
  session re-checks the capability and the cluster grant.

**K5 — integrations** (AI, alerts, fleet overview):

- **AI tools** (`ai-tools.ts`, `ai/tools.ts`): `kube_list_workloads`, `kube_describe`,
  `kube_events`, `kube_pod_logs` — read-only, plain text, through `withKubeClient` like
  every route (cluster access → "Cluster not found", the namespace allowlist, the §7
  matrix: `kube_describe` needs `yaml`, `kube_pod_logs` needs `logs`, both operator+; the
  chat itself is operator+). Objects go through `redactObject` and lose the last-applied
  annotation; logs are a `tailLines` (≤ 500) read with `limitBytes`, newest lines kept
  under the 64 KB cap. The system prompt lists the clusters the user may use. The chat
  route audits each call as `ai.kube_read` against the cluster (tool, object — never the
  output). The assistant never changes a cluster.
- **Explain** (`POST /api/kube/clusters/:id/explain`, `api/routes/kube-ai.ts`): operator+,
  rate-limited (10/min). `explainMaterial` gathers the redacted object (capped), its
  health, events about it and its troubled pods, the state of a workload's troubled pods
  and — with `logs` — a short tail of the first troubled container (the previous run for a
  crash loop); it goes to the org's AI provider with a "you cannot act" system prompt, and
  the answer streams back as `KubeExplainEvent`s (`context` says what was sent). The
  stream is a `kube` stream in `api/sse.ts` (per-user cap, ends when access to the
  cluster is revoked). Audited as `kube.ai_explain` with counts, not content.
- **Fleet overview** (`GET /api/kube/overview`, `fleet.ts`, `api/routes/kube-fleet.ts`):
  viewer; every accessible cluster through `withKubeClient` and the watch cache, five at
  a time (Docker's `mapPooled`) with 10 s each; a cluster that fails or hangs is an
  error row, never a failed page. Each row: nodes ready/cordoned, pods by tile colour,
  replicated workloads by health, the worst problems (linked objects) and open alerts.
- **Cluster alerts** (`alerts.ts`, opt-in `clusterAlerts`, off by default): after each
  health sweep (`monitoring/scheduler.ts`) the clusters of opted-in orgs are read with
  their own credential (no impersonation; the allowlist applies) from the shared cache.
  Types: `kube_cluster_unreachable` (3 failed reads in a row; other alerts stay as they
  were), `kube_node_not_ready`, `kube_workload_unavailable` (Deployment / StatefulSet /
  DaemonSet health `failed`), `kube_pod_crashloop` (CrashLoopBackOff, or ≥ 3 restarts in
  10 min, as for containers), `kube_pod_pending` (> 10 min). Pod alerts group by owning
  workload; at most 25 per cluster. One open alert per (cluster, type, object),
  notifications on open/resolve only through `notifyAlertsChanged` with the cluster as
  `subject` and the object as `container`, so the channels' dedup key is
  `smt:<cluster>:<type>:<object>`; a reopen within 30 min of resolving is quiet (and so
  is its resolution). `server_alerts.server_id` is a foreign key to servers, so cluster
  alert state is in memory: a restart re-announces alerts still firing under the same
  dedup key.

### 4.17 Custom Roles and the Access Engine (`/server/auth/access`)

Design: `docs/superpowers/specs/2026-10-04-custom-roles-design.md`.

- Every member has a base role and a **scope**: `all` (the base role applies to every
  resource, as before) or `roles` (only what their custom roles and personal grants cover;
  default deny). Owners and admins have `manage` on everything; roles never grant org-admin
  features. A resource's level is the highest of the base level (scope `all`), each role and
  each personal grant covering it: `view < operate < manage` (`levels.ts` maps every action
  per resource type to the level it needs).
- `resolve.ts` loads the membership, active role memberships and unexpired grants in three
  queries, memoized on the request (for at most a second). `authorize.ts` (`levelFor`,
  `authorize`, `requireResource`) answers 404 when a resource is unreachable and 403 when the
  level is too low; `filter.ts` gives the SQL fragment (`accessibleFilter`, with server tag
  selectors matched against `servers.tags` via `json_each` at query time) and the in-memory
  equivalent; `explain.ts` lists the reasons; `revoke.ts` (`revokeAfterChange`) diffs
  before/after snapshots and calls `revokeLiveAccess` with keep sets — visible resources keep
  their streams, shells (terminals, SFTP, pod and container shells) need `operate`, FTP
  sessions are kept per connection.
- `auth/server-access.ts` and `auth/cluster-access.ts` keep their exports as wrappers. The
  Docker and Kubernetes matrices are read at the caller's level on the server or cluster in
  the route (`operate` as operator with the org toggles, `manage` as admin). A cluster grant
  narrowed to namespaces gives its level in those namespaces only; on the cluster as a whole
  (no namespace asked) it gives `view` at most. A cluster manager below admin may re-route the
  cluster only through a server they can operate, never through an agent.
- FTP/SFTP connections, storage connections and cloud accounts: lists are filtered with
  `accessibleFilter`, every by-id route (and FTP/storage diagnostics) is gated with
  `requireResource` at the §5 level; creating one stays admin-only. The base role (scope
  `all`) keeps what it always allowed at view — browsing and downloading FTP files,
  downloading objects (`BASE_VIEW_ACTIONS`) — and pooled FTP sessions are kept where the
  member may still browse. A manager below admin cannot pick an org SSH key (FTP key auth,
  a cloud account's import key), re-aim a key-auth connection, or send a stored FTP
  password to a new endpoint (or with TLS checks off) without entering it again.
- Saved commands and cron jobs (`auth/command-access.ts`): seeing one needs `view` on it, and
  a command bound to a server, or a job, is also hidden with its server. Running a command
  needs `operate` on it and on every target server (a tag fan-out is refused if any tagged
  server it sees is view-only); rewriting one needs `operate` on the servers of the cron jobs
  that run it. A job: `view` for its history, `operate` to run it now (`POST
  /api/cron-jobs/:id/run`) or switch it on/off, `manage` to edit or delete it; creating,
  moving, changing what it runs, switching it on or running it now also needs `operate` on its
  server (and on its saved command); switching it off does not.
  Creating either needs `manage` on all of the type. Jobs run as their creator, who must
  still operate the job, its server and its saved command at run time. Scope-`all` operators
  keep their pre-roles rights (edit commands, edit/delete jobs, create both); `GET
  /team/access/mine` reports them as `baseActions` so the web still shows those buttons.
- Until the team and access-request routes write `resource_grants` themselves, triggers from
  migration 0023 mirror `member_server_access` / `member_cluster_access` into personal grants
  (at the member's base-role level, following role changes) and `server_access` into `scope`.
- The access-grant expiry sweep also removes expired role memberships and grants and closes
  what they gave.
- **Servers, clusters and their dependents** gate on the level, not the base role
  (`requireServer(action)` / `serverDenial` in `server-access.ts`, `clusterDenial` in
  `cluster-access.ts`, `requireResource`): view — detail, health, metrics, Docker lists;
  operate — terminal (and its WebSocket re-attach), SFTP read and write, diagnostics, health
  checks, alert acknowledgement, AI `run_command`; manage — edit, tags, host keys, key
  rotation, monitoring on/off, delete. `requireDocker` / `requireKube` answer 404 for an
  unreachable server or cluster before weighing the capability; `requireKube(cap, 'param' |
  'body')` reads the Kubernetes matrix at the caller's level in the request's namespace, and
  `KubeContext.allowlist` is the cluster allowlist narrowed to the caller's granted
  namespaces (`permissionsIn(ns)` for per-namespace checks; `GET /clusters/:id` returns
  `namespacePermissions`). Container and pod shells are closed by level too; revocation weighs
  pod shells in their own namespace, so narrowing a grant's namespaces closes the shells it no
  longer covers. Creating servers stays admin-only; a server manager below admin cannot choose
  its SSH key or agent, nor change where it connects (host, port, user, jump host) — even with
  a new password, since any org key a terminal names would follow — but may set a new password
  for the same endpoint. Changing a server's tags is audited (`server.tags_change`) with the
  roles whose tag grants it moves, and closes what members lost.
- API (`api/routes/team-access.ts`, under `/api/team`): roles CRUD, `PUT /roles/:id/grants`
  (the list is replaced atomically by `grants.ts`), `POST`/`DELETE /roles/:id/members` (optional
  expiry), `PUT /members/:userId/grants` (personal grants), the access checker
  (`GET /access/explain`), who-has-access (`GET /access/resource`), picker data
  (`GET /access/resources`) — all admin — and `GET /access/mine?type=` for anyone (their level
  per resource, from `effective.ts`, so the web hides buttons). `PATCH /members/:userId` takes
  `scope`; `GET /members/:userId/access` adds scope, roles, personal grants and the effective
  access per type to the old fields. Every change snapshots the affected members first and
  calls `revokeAfterChange`, and is audited with before/after. The old
  `PUT /members/:userId/access` stays as an alias: it writes the mirrored tables, keeps newer
  personal grants (and their level) for servers and clusters it still lists, and drops them for
  those it leaves out.
- Access requests may ask for a role (`role_id`; approval adds a time-bound role membership),
  for servers or clusters at the base role's level (`serverIds` / `clusterIds`, plain id list
  under `resource_type`; `GET /access-requests/servers` and `/clusters` list them by name),
  or for resources of any type at a level (`server_ids` holds `{ ids, level }` under
  `resource_type`; approval adds time-bound personal grants, never shortening what is held).
  Members may ask for what they already see (a higher level, or longer), servers by name when
  the org lists them, and any role by name (`GET /access-requests/requestable`).
- Web: Team & Access has Members (member detail: scope, roles, personal grants, effective
  access with "via" badges), Roles (editor with per-type pickers, tag selectors with a live
  count, namespace chips, a plain-language preview) and Access checker tabs; server, cluster,
  connection, cloud, command and cron pages have a "who has access" button for admins
  (`components/access/`); `hooks/useAccessLevels.ts` hides actions the level does not allow.

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
Organization 1───* FtpConnection
Organization 1───* AuditLogEntry
User         1───* APIToken
```

### Key tables

- **organizations** — root tenant scope inside an instance.
- **users** — global; can belong to multiple orgs.
- **memberships** — `(user_id, org_id, role)`. Role is one of `owner | admin | operator | viewer`. `scope` is `all | roles` (§4.17); `server_access` mirrors it for one release.
- **roles** — custom roles: `name` (unique per org), `description`, `color`. **role_members** — `(role_id, user_id)`, `expires_at`. **resource_grants** — `principal_type` (`role | user`), `principal_id`, `resource_type` (seven types), `selector` (`id | all | tag`), `resource_id`, `tag`, `namespaces` (clusters), `level` (`view | operate | manage`), `expires_at`, `granted_by`, `reason`.
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
- **ftp_connections** — `name`, `host`, `port`, `protocol` (`ftp | ftps | ftps-implicit`), `username`, `encrypted_password`, `verify_tls`, `root_path`, last-test status.
- **audit_log** — append-only, partitioned by month.
- **sessions** — browser auth sessions (Lucia).
- **api_tokens** — programmatic access tokens, scoped + hashed.
- **sso_providers** — one OIDC provider per org: `issuer`, `client_id`, `encrypted_client_secret`, allowed domains, default role, auto-provision / enforce / trust-IdP-MFA flags, groups claim + role mappings.
- **user_identities** — `(provider_id, subject)` unique → `user_id`; **sso_login_states** — pending sign-ins (state hash, encrypted PKCE verifier, nonce), 10-minute lifetime.
- **kube_clusters** — `name`, `api_url`, `connect_via` (`direct | server | agent`), `via_server_id` / `via_agent_id`, `ca_data`, `auth_type` (`token | cert`), `encrypted_credential`, `credential_hint`, `impersonate`, `default_namespace`, `namespaces_allowlist`, last health. **member_cluster_access** — `(org_id, user_id, cluster_id)` grants for restricted members, with `expires_at`. **organizations.kube_settings** — JSON, see §4.16.

### Encrypted columns

`ssh_keys.encrypted_private_key`, `ai_provider_configs.encrypted_api_key`, `storage_connections.encrypted_secret_access_key`, `ftp_connections.encrypted_password`, `sso_providers.encrypted_client_secret` and `kube_clusters.encrypted_credential` are encrypted with the vault. Plaintext exists only transiently in process memory during use.

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
- Per-org OpenID Connect SSO (`/server/auth/sso.ts`, `openid-client`): code flow + PKCE, state/nonce/verifier kept server-side, ID token checked against the IdP JWKS; identities keyed by (provider, `sub`) in `user_identities`. SSO sessions carry `sessions.sso_provider_id` and only work in that org (see 4.13 for what they may manage). No SAML.
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
| FTP connections             | viewer   | admin       |
| FTP list / download         | viewer   | —           |
| FTP upload / mkdir / rename / delete | — | operator |
| AI chat                     | —        | operator    |
| Docker lists, info, events  | viewer   | —           |
| Docker logs, stats, top, inspect | operator | —      |
| Docker org settings, server probe | viewer (settings) | admin |
| Docker start / stop / restart / pause / kill, pull | — | operator |
| Docker shell in a container | — | operator if `operatorsCanExec`, else admin |
| Docker remove containers / images | — | operator if `operatorsCanRemove`, else admin |
| Docker prune               | —        | admin, if `allowPrune` |
| Docker env reveal          | —        | admin + passkey step-up |
| Docker fleet view (Containers page) | viewer | —      |
| AI Docker tools (list / logs, inspect) | operator (chat) | — |
| Kubernetes clusters list, map, namespaces, workloads, redacted details, change feed | viewer (granted clusters) | — |
| Kubernetes read-only YAML (Secret values stripped) | operator | — |
| Kubernetes org settings | viewer | admin |
| Kubernetes clusters add / edit / remove / test, impersonation | — | admin |
| Kubernetes scale, restart rollout, CronJob suspend / trigger (K3) | — | operator if `operatorsCanScale`, else admin |
| Kubernetes delete pod (K3) | — | operator if `operatorsCanDeletePods`, else admin |
| Kubernetes roll back, cordon / uncordon (K3) | — | admin |
| Kubernetes pod logs / shell (K4) | operator (logs) | operator if `operatorsCanExec`, else admin |
| Kubernetes fleet overview (K5) | viewer (granted clusters) | — |
| Kubernetes AI tools and Explain (K5; describe needs YAML, logs need logs) | operator | — |
| Kubernetes cluster alerts setting (K5) | viewer | admin |

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
- Backup: built-in scheduled SQLite backups to `/data/backups` (optionally copied to object storage) + `SMT_ENCRYPTION_KEY` stored separately.

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
│       │   ├── ftp/      # FTP / FTPS client + ops
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
| `SMT_LOG_LEVEL`          | no       | `info` (default), `debug`, `warn`, `error`                    |
| `SMT_MAX_SSH_SESSIONS`   | no       | Per-user concurrent SSH session cap                           |
| `SMT_AI_REQUEST_TIMEOUT` | no       | Timeout for outbound AI calls (ms)                            |
| `SMT_SFTP_MAX_UPLOAD_BYTES` | no    | Max SFTP upload size in bytes (default 1 GiB)                 |
| `SMT_STORAGE_MAX_UPLOAD_BYTES` | no | Max object-storage upload size in bytes (default 5 GiB)       |
| `SMT_FTP_MAX_UPLOAD_BYTES` | no     | Max FTP upload size in bytes (default 1 GiB)                  |
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
| `SMT_WEBAUTHN_RP_ID`     | no       | Passkey RP ID (default: hostname of `SMT_BASE_URL`)           |
| `SMT_WEBAUTHN_RP_NAME`   | no       | Name shown in passkey prompts (default `BastionSSH`)          |
| `SMT_WEBAUTHN_ORIGINS`   | no       | Comma list of origins allowed to use passkeys (default: origin of `SMT_BASE_URL`, plus the Vite dev server in development) |

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
