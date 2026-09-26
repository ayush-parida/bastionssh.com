# BastionSSH (bastionssh.com)

> An open-source, **browser-based** tool to manage multiple SSH keys, multiple servers, and connect to them right from your browser — supercharged with your own AI model (OpenAI, Claude, or any local LLM).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker Pulls](https://img.shields.io/badge/docker-ready-blue)](#-installation)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#-contributing)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4%EF%B8%8F-pink.svg)](https://github.com/sponsors/ayush-parida)

---

## ✨ Features

- 🌐 **100% Browser-Based** — Manage everything from a clean web UI. No desktop app, no terminal required.
- 🔑 **SSH Key Management** — Generate, import, organize, and rotate multiple SSH keys.
- 🖥️ **Server Inventory** — Add, tag, and group unlimited servers (production, staging, clients, personal, etc.).
- 💻 **In-Browser Terminal** — Full interactive SSH sessions in your browser via WebSocket + xterm.js.
- 📌 **Saved Commands per Server** — Save frequently-used commands against any server and run them with one click.
- ⏰ **App-Level Cron Jobs** — Schedule recurring commands that run **from the application** (not from the server's crontab). Keeps your servers untouched and gives you a single place to view history, logs, and failures.
- ☁️ **Cloud Inventory Sync** — Register an AWS, Google Cloud, Azure, DigitalOcean or Hetzner Cloud account and its instances appear as servers, tagged by provider and region, and stay current: new instances are imported, changed IPs are picked up, stopped and deleted instances are flagged. Read-only credentials; nothing is ever changed in your cloud account.
- 🌐 **DNS Lookup** — Check a domain's records and nameservers from inside the tool. Addresses that belong to a server you manage are labelled with its name, and the same lookup is run against several public resolvers plus the domain's own nameservers so you can see whether a change has propagated.
- 🪣 **Object Storage** — Register AWS S3, MinIO, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, Google Cloud Storage, Hetzner Object Storage or any S3-compatible endpoint (presets fill in the endpoint shape and region). List, create and delete buckets; browse, upload, download, rename and delete objects — all from the same UI and audit log as your servers.
- 📂 **FTP / FTPS** — Register FTP, explicit-FTPS or implicit-FTPS servers (shared hosting, cPanel, legacy appliances) with a stored, vault-encrypted password. Browse directories, upload, download, rename and delete — same roles and audit log as everything else.
- 📊 **Agentless Health Monitoring** — Every server is polled over SSH for uptime, load, CPU, memory, disk and process count. Live status on the dashboard, per-server history charts, and alerts when a host goes down or fills up — delivered to Slack, Discord, Teams, Google Chat, Telegram, PagerDuty, Opsgenie, ntfy, Gotify, Pushover, email or any webhook. Nothing to install on the servers themselves.
- 👥 **Team Collaboration** — Invite teammates, assign roles, share servers, keys, saved commands, and cron jobs across an organization with full audit logs.
- 🏠 **Self-Hosted Environments** — Spin up your own instance in minutes (Docker, Compose, or binary). Each team/company runs an isolated environment they fully control.
- 🤖 **Bring Your Own AI** — Plug in OpenAI, Anthropic Claude, or any local model (Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible endpoint) to:
  - Suggest shell commands from natural language
  - Explain command output and logs
  - Diagnose errors
  - Generate scripts on the fly
- 🔒 **Secure by Default** — All keys and credentials encrypted at rest. Self-hosted, no telemetry, no cloud lock-in.
- 📦 **Easy to Distribute** — Single Docker image, `docker compose` one-liner, or prebuilt binaries.

---

## 📦 Installation

The easiest way to run it — pick whichever you prefer.

### Option 1: Docker (recommended)

```bash
docker run -d \
  --name bastionssh \
  -p 8080:8080 \
  -v bastionssh_data:/data \
  ghcr.io/ayush-parida/bastionssh:latest
```

Open http://localhost:8080 and you're done.

### Option 2: Docker Compose

```yaml
# docker-compose.yml
services:
  bastionssh:
    image: ghcr.io/ayush-parida/bastionssh:latest
    ports:
      - '8080:8080'
    volumes:
      - bastionssh_data:/data
    restart: unless-stopped

volumes:
  bastionssh_data:
```

```bash
docker compose up -d
```

### Option 3: Prebuilt Binary

Download the latest release for your platform from the [Releases page](#) and run:

```bash
./smt serve --port 8080
```

### Option 4: Build from Source

```bash
git clone https://github.com/<your-org>/server-management-tool.git
cd server-management-tool
# follow build instructions in CONTRIBUTING.md
```

---

## 🚀 Quick Start

1. Open `http://localhost:8080` in your browser.
2. Sign in as the first admin (an owner account seeded on first start):
   - Set `SMT_ADMIN_EMAIL` and `SMT_ADMIN_PASSWORD` before the first start to choose the credentials.
   - Unless `NODE_ENV` is explicitly `development` or `test`, an unset `SMT_ADMIN_PASSWORD` (or the dev default `admin1234`) gets a random password instead, printed **once** to the server's stderr (`Generated a random admin password`) whatever `SMT_LOG_LEVEL` is. This covers the Docker image and a bare `pnpm start` / `node dist/index.js`. Sign in and change it.
   - `pnpm dev` runs with `NODE_ENV=development`, where the defaults are `ayush.parida@fgshq.com` / `admin1234`.
3. **Add an SSH key** — paste an existing one or generate a new keypair from the UI.
4. **Add a server** — host, port, user, and select the SSH key.
5. Click **Connect** to open an in-browser terminal, or use the **Run** button to execute saved commands.

---

## 📌 Saved Commands

Attach commands to any server for instant one-click execution.

- Group by category (Maintenance, Deploy, Diagnostics, etc.)
- Parameterize with variables (`{{branch}}`, `{{service}}`)
- View output history per command
- Share command libraries across servers via tags

---

## ⏰ App-Level Cron Jobs

Unlike server-side `crontab`, these jobs are scheduled and executed **by the application** over SSH.

Why this is better for many teams:

- ✅ Nothing installed or modified on your servers
- ✅ Centralized view of all scheduled tasks across your fleet
- ✅ Unified logs, run history, and failure alerts
- ✅ Pause / resume / edit schedules without SSH'ing in
- ✅ Works even on ephemeral or read-only servers

Each cron job has:

- A target server (or group)
- A command (or saved command reference)
- A schedule (cron expression or human-readable)
- Run history with stdout/stderr and exit codes
- Optional notifications on failure (webhook, email)

---

## 📊 Health Monitoring

Every server is checked on a schedule over SSH — **no agent, no daemon, nothing installed on the host**. A single read-only probe reads `/proc` and `df`, so a check costs one short-lived connection.

Collected per check:

| Metric        | Source                              |
| ------------- | ----------------------------------- |
| Reachability  | SSH handshake (with latency in ms)  |
| Uptime        | `/proc/uptime`                      |
| Load average  | `/proc/loadavg` (normalized per core) |
| CPU usage     | `/proc/stat` delta between checks   |
| Memory / swap | `/proc/meminfo`                     |
| Disk usage    | `df -Pk`, every real filesystem     |
| Processes     | `ps -e`                             |
| Logged-in users | `who`                             |
| OS / kernel   | `/etc/os-release`, `uname`          |

What you get:

- 🟢 **Live status** on the Dashboard, Servers list, and a dedicated Monitoring page
- 📈 **History charts** per server — CPU, memory, load, disk and SSH response time over 1h / 6h / 24h / 7d
- 🚨 **Alerts** that open when a host goes unreachable or crosses a CPU / memory / disk / load threshold, and resolve themselves when it recovers
- ⏸️ **Per-server pause** for hosts you don't want checked
- 🧹 **Automatic retention** — samples older than `SMT_MONITORING_RETENTION_HOURS` (default 7 days) are pruned

Hosts without `/proc` (macOS, BSD) still report whatever they can — reachability, disks, process count — instead of failing the check.

Tuning (all optional, shown with defaults):

```bash
SMT_MONITORING_ENABLED=true          # set false to turn health checks off entirely
SMT_MONITORING_INTERVAL=60           # seconds between sweeps
SMT_MONITORING_CONCURRENCY=5         # servers probed in parallel
SMT_MONITORING_RETENTION_HOURS=168   # how long samples are kept
SMT_ALERT_CPU_PERCENT=90
SMT_ALERT_MEMORY_PERCENT=90
SMT_ALERT_DISK_PERCENT=90
SMT_ALERT_LOAD_PER_CORE=2
SMT_ALERT_OFFLINE_FAILURES=2         # failed checks before a host is alerted as down
```

### Alert notifications

Under **Settings → Alert notifications**, add one or more channels. Each channel can be limited to critical alerts and can opt out of "resolved" notices.

| Channel | What you need |
| ------- | ------------- |
| Slack / Mattermost | An incoming-webhook URL |
| Discord | A channel webhook URL (Channel settings → Integrations → Webhooks) |
| Microsoft Teams | A Workflows webhook URL (posts an Adaptive Card) |
| Google Chat | A space webhook URL |
| Telegram | A bot token from @BotFather and the chat id |
| PagerDuty | An Events API v2 integration key — incidents open on alert and resolve when it clears |
| Opsgenie | An API integration key and region (US / EU) — alerts are created and closed by alias |
| ntfy | The topic URL; `user:password@host` for a protected server |
| Gotify | Your server's `/message?token=…` URL |
| Pushover | An application token and your user key |
| Email | SMTP configured on the instance (below); the channel lists up to 20 recipients |
| Webhook | Any HTTPS endpoint — receives a structured JSON body; `user:password@` becomes Basic auth |

Email needs two environment variables. The Email option stays disabled in the UI until they are set:

```bash
SMT_SMTP_URL=smtp://user:password@smtp.example.com:587   # or smtps://…:465
SMT_SMTP_FROM="BastionSSH <alerts@example.com>"
```

---

## ☁️ Cloud Accounts

Under **Cloud Accounts**, register a provider credential once and stop adding servers by hand:

| Provider | Credential | Minimum permission |
| -------- | ---------- | ------------------ |
| AWS EC2 | Access key ID + secret | `ec2:DescribeInstances`, `ec2:DescribeRegions` |
| Google Cloud | Service account JSON key | Compute Viewer on the project |
| Microsoft Azure | Service principal (tenant, client id, secret, subscription) | Reader on the subscription |
| DigitalOcean | Personal access token | read scope |
| Hetzner Cloud | Project API token | read |

Each account has a default SSH username and key that imported servers start with. A sync then:

- imports instances that are not known yet (public IP preferred, private IP as fallback; instances with neither are skipped),
- refreshes the host, region and state of servers it already imported — your name, tags, credentials and notes are never overwritten,
- marks servers whose instance has disappeared as **missing** and never deletes them,
- excludes **stopped** and **missing** cloud servers from health checks so they do not raise offline alerts.

Sync runs on a schedule and on demand (**Sync now**). Deleting an account keeps the servers and only unlinks them.

```bash
SMT_CLOUD_SYNC_ENABLED=true     # set false to turn the scheduled sync off (manual sync still works)
SMT_CLOUD_SYNC_INTERVAL=15      # minutes between syncs (minimum 5)
SMT_CLOUD_REQUEST_TIMEOUT=30000 # per-request provider timeout in ms
```

---

## 🌐 DNS Lookup

Open **DNS Lookup**, enter a domain, and get back:

- **Nameservers**, each with the addresses they resolve to.
- **Records**: A, AAAA, CNAME, MX, TXT, SOA and CAA, with TTLs where the resolver reports them.
- **Server matches** — an A, AAAA or CNAME value that equals one of your servers' hosts is labelled with that server's name and links to its health page. This is the "which of my machines is this domain pointing at?" question.
- **Propagation** — the same A lookup run against Cloudflare, Google, Quad9 and OpenDNS plus the domain's own nameservers, with any resolver that disagrees flagged. Useful right after you repoint an app.

Paste whatever you have: a bare domain, a full URL, a trailing dot, or a unicode domain. It is normalised before the query. A domain that does not exist is called out as such, rather than looking the same as one with no records.

The resolver list is fixed, so the endpoint cannot be used to send traffic to an arbitrary host, and a nameserver that resolves to a private or link-local address is never queried. Lookups are read-only, available to any signed-in role, and recorded in the audit log.

---

## 🪣 Object Storage

Add an S3-compatible connection under **Object Storage** with an endpoint, region and access-key pair. Presets for AWS S3, MinIO, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, Google Cloud Storage (HMAC) and Hetzner Object Storage fill in the endpoint shape, region and addressing style; anything else that speaks S3 (Ceph RGW, Garage, Linode, Scaleway, OVH…) works under "Other". The secret key is encrypted at rest with the same vault as SSH keys and never leaves the server.

- Buckets: list, create, delete (optionally emptying it first, with a typed-name confirmation)
- Objects: browse by folder, upload (streamed, multipart above 8 MiB), download, rename, delete a file or a whole folder
- Every action is audited with the bucket and key
- Roles: viewers browse and download, operators change objects, admins manage connections and buckets

Uploads are capped by `SMT_STORAGE_MAX_UPLOAD_BYTES` (default 5 GiB).

## 📂 FTP / FTPS

Some hosts only speak FTP. Add one under **FTP** with a host, port, protocol and username/password. Explicit FTPS (TLS upgrade on port 21) is the default; implicit FTPS (port 990) and plain FTP are available for servers that need them, and certificate verification can be turned off for a self-signed box. The password is encrypted at rest with the same vault as SSH keys and never leaves the server.

- Browse from the account's login directory or a configured start directory
- Upload (streamed), download, create folders, rename, delete a file or a whole tree
- Roles: viewers browse and download, operators change files, admins manage connections
- One logged-in session per user per connection, reused across requests and closed after two minutes idle

Uploads are capped by `SMT_FTP_MAX_UPLOAD_BYTES` (default 1 GiB).

---

## 👥 Collaboration

Work as a team without sharing SSH keys over Slack ever again.

- **Organizations & workspaces** — Group your team under a shared environment.
- **Roles & permissions** — `Owner`, `Admin`, `Operator`, `Viewer`. Fine-grained access per server, key, command, or cron job.
- **Shared resources** — Servers, SSH keys, saved commands, and cron jobs can be private to a user or shared with the team.
- **Invite by email or link** — Onboard teammates in seconds.
- **Audit log** — Every connection, command run, key access, and config change is recorded with the actor, timestamp, and target.
- **Session sharing (optional)** — Pair-debug a server with a teammate in a live shared terminal.

---

## 🏠 Self-Hosted Environment Setup

Every team runs their own isolated instance. No central SaaS, no shared multi-tenant cloud — your environment, your data.

A typical self-hosted setup:

```
┌─────────────────────────────────────────────────────┐
│                  Your Infrastructure                │
│                                                     │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    │
│   │  Browser │───▶│   SMT    │───▶│  Servers │    │
│   │  (Team)  │    │ Instance │SSH │ (Fleet)  │    │
│   └──────────┘    └────┬─────┘    └──────────┘    │
│                        │                            │
│                   ┌────▼─────┐                      │
│                   │ Encrypted│                      │
│                   │  Volume  │                      │
│                   └──────────┘                      │
└─────────────────────────────────────────────────────┘
```

**Recommended production setup:**

```yaml
# docker-compose.yml
services:
  bastionssh:
    image: ghcr.io/ayush-parida/bastionssh:latest
    environment:
      - SMT_BASE_URL=https://bastionssh.yourcompany.com
      - SMT_ENCRYPTION_KEY=${SMT_ENCRYPTION_KEY} # generate once, keep secret
      - SMT_DB_URL=postgres://bastionssh:bastionssh@db:5432/bastionssh # optional; SQLite by default
      - SMT_OAUTH_PROVIDER=google # optional SSO
    ports:
      - '8080:8080'
    volumes:
      - bastionssh_data:/data
    depends_on: [db]
    restart: unless-stopped

  db:
    image: postgres:16
    environment:
      POSTGRES_USER: bastionssh
      POSTGRES_PASSWORD: bastionssh
      POSTGRES_DB: bastionssh
    volumes:
      - bastionssh_db:/var/lib/postgresql/data
    restart: unless-stopped

volumes:
  bastionssh_data:
  bastionssh_db:
```

Then put it behind your reverse proxy of choice (Caddy / Nginx / Traefik) with TLS, invite your team, and you're live.

**Behind a reverse proxy (upgrade note):** earlier versions trusted `X-Forwarded-For` from anyone. The server now trusts no proxy unless told to, so an existing Caddy/Nginx/Traefik deployment must set `SMT_TRUST_PROXY` (usually `1`) — otherwise every user shares the proxy's IP, and with it one rate-limit bucket (100 requests/min overall, 10 logins/min) and one audit-log IP. The server logs a warning the first time it sees a forwarded request while this is unset. Set `SMT_TRUST_PROXY` so client IPs (used for rate limiting and the audit log) come from `X-Forwarded-For`. It defaults to `false` — trust no proxy — because trusting every hop lets any client pick its own IP. Accepted values: `true` (trust all hops; only when the app is unreachable except through the proxy), a hop count such as `1`, or a comma-separated list of proxy IPs/CIDRs such as `10.0.0.0/8,127.0.0.1`.

**Storage backends:**

- **SQLite** (default) — zero-config, perfect for solo / small teams.
- **PostgreSQL** — recommended for teams of 5+ or HA setups.

**Authentication options:**

- Built-in email/password
- Passkeys (WebAuthn) — passwordless sign-in, or a second step after the password
- OAuth / SSO (Google, GitHub, GitLab, generic OIDC)
- Optional 2FA (TOTP)

### Passkeys

Anyone can add passkeys under **Settings → Passkeys**. Once an account has one, signing in with the password also asks for it, and **Sign in with a passkey** on the login page works without the password. Owners can turn on **Team → Require passkeys for this organization**: members then have to have used a passkey in their current session to do anything in that org, and anyone without one is asked to create it right after signing in. Enabling it requires the owner's own session to be passkey-verified, so an owner cannot lock themselves out, and ends open terminals, file sessions and AI chats in that org for members who have no passkey-verified session. Under the policy only API tokens created from a passkey-verified session work; older tokens must be recreated.

A first passkey needs the account password again and a sign-in from the last 15 minutes; enrolling it signs out the account's other password-only sessions. Once an account has a passkey, changing the password, creating API tokens, and (for admins) issuing password-reset links or resetting someone's passkeys need a session that has used it. When SMTP is configured (`SMT_SMTP_URL`), people are emailed whenever a passkey is added to their account.

**Backup codes.** Once an account has a passkey, **Settings → Passkeys → Backup codes** generates ten one-time recovery codes (`XXXXX-XXXXX`, Crockford base32). They are shown once — copy or download them — and generating a new set invalidates the old one. When you sign in with your password, **Use a backup code instead** finishes the sign-in without the passkey; the session then counts as passkey-verified, so you can add a new passkey and remove the lost one. Codes are case-insensitive and the dash is optional. They are not accepted for passwordless sign-in or to confirm a passkey (step-up), and a pending sign-in is dropped after five wrong codes. Generating codes needs a passkey-verified browser session; removing your last passkey, or an admin passkey reset, deletes them. Only an HMAC of each code (keyed from `SMT_SESSION_SECRET`) is stored, so rotating that secret invalidates every backup code. With SMTP configured, people are emailed when codes are generated and whenever one is used.

Lost passkey and no backup codes? An admin or owner who outranks the member can **Reset passkeys** on the Team page. That removes all of their passkeys and signs them out; they sign in with their password and enroll a new one. As with admin password resets, this is refused for someone who also belongs to another organization.

Browsers only offer passkeys on **HTTPS** pages or on **localhost**, and a passkey is bound to the RP ID (a domain), so choose it before your team enrolls:

```bash
SMT_WEBAUTHN_RP_ID=bastionssh.yourcompany.com   # default: hostname of SMT_BASE_URL
SMT_WEBAUTHN_RP_NAME=BastionSSH                 # shown in the browser prompt
SMT_WEBAUTHN_ORIGINS=https://bastionssh.yourcompany.com  # comma list; default: origin of SMT_BASE_URL
```

With `NODE_ENV=development` the Vite dev server (`http://localhost:5173`) is allowed too, unless `SMT_WEBAUTHN_ORIGINS` is set. Changing the RP ID later makes every existing passkey unusable.

---

## 🤖 AI Integration

Configure any provider you want — your keys stay on your instance.

| Provider                | Notes                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| **OpenAI**              | GPT-4, GPT-4o, etc.                                              |
| **Anthropic Claude**    | Claude 3.5 / Opus / Sonnet / Haiku                               |
| **Local / Self-hosted** | Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible API |

Configure from **Settings → AI Providers** in the UI, then use AI to:

- Generate commands from natural language
- Explain output of any saved command or terminal session
- Suggest fixes for failed cron runs
- Write scripts and one-liners

---

## 🔐 Security

- SSH keys and API credentials encrypted at rest.
- All traffic between browser and app is local (or HTTPS if you put a reverse proxy in front).
- No telemetry. No external calls except to the AI provider you configure.
- Self-hosted — your data never leaves your infrastructure.

> ⚠️ For production deployments, run behind a reverse proxy (Caddy, Nginx, Traefik) with TLS and authentication.

---

## 🛣️ Roadmap

- [ ] SFTP / file browser
- [ ] Multi-server command execution (fan-out)
- [x] Server monitoring (CPU, memory, disk)
- [ ] Live shared terminal sessions
- [ ] End-to-end encrypted secret sharing
- [ ] Plugin marketplace

---

## 🤝 Contributing

Contributions are welcome! This is an open-source project and we'd love your help.

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/amazing`)
3. Commit your changes
4. Open a Pull Request

See `CONTRIBUTING.md` for development setup and guidelines.

---

## 📄 License

MIT © Contributors
