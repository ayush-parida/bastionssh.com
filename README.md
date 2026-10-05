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
- 🩺 **Connectivity Diagnostics** — One click walks DNS, TCP, TLS or the SSH banner, the host key and (optionally) a login for a server, FTP/SFTP or storage connection, says which step failed and what to fix, and shows the app's egress IP for firewall rules.
- 🎥 **Session Recording** — Terminal sessions and one-shot command runs are recorded as asciicast and can be replayed in the browser or downloaded, with a searchable command log.
- ☸️ **Kubernetes** — See a cluster at a glance: nodes with their pods as coloured tiles, pods waiting for a node and why, workloads with their health and redacted details, all live — no kubectl. Clusters are reached directly, through a managed server's SSH connection or through an agent, with TLS always verified and Secret values never leaving the server.
- 🐳 **Docker** — Containers, images, volumes and networks per server with live status, logs, stats and redacted inspect; container actions, pulls and prune, recorded shells in containers, Compose projects, a cross-server Containers view and opt-in container alerts — all over the server's existing SSH connection, no agent, no exposed daemon port.
- 🪜 **Jump Hosts & Private Networks** — Reach servers through one or more bastions (like `ssh -J`), or through a small outbound agent on a private network that needs no inbound port.
- 💾 **Automatic Database Backups** — Online, consistent backups of the app's own database on a schedule and before every upgrade, with retention, optional off-site copies to object storage, and a one-command restore.
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

A changed SSH host key (a server's or an SFTP connection's) is notified at most once an hour per server and presented key, so a host flapping between keys does not flood the channels; the alert itself, the mismatch shown in the UI and the audit log still follow every change (audit rows are capped per key every 10 minutes).

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
- refreshes the host, region, state and provider tags of servers it already imported — your name, tags, credentials and notes are never overwritten,
- marks servers whose instance has disappeared as **missing** and never deletes them,
- excludes **stopped** and **missing** cloud servers from health checks so they do not raise offline alerts.

Imported servers get `cloud:<provider>` and the region as tags. The provider's own tags (AWS tags, GCP labels, Azure tags, DigitalOcean and Hetzner labels) are shown on the server as **provider tags** (dashed, with a cloud icon) and refreshed on every sync, but they are not the server's tags: custom role tag selectors and saved-command tag targets never match them, so whoever can tag instances in the provider cannot decide who reaches them in BastionSSH. Servers imported before this change keep the tags they were imported with (which included the provider's) — nothing records which came from the provider, so remove any you do not want used for access.

Adding an account and changing its credentials are admin-only. A member who manages an account through a custom role can rename it, change its regions, username and auto-import, switch sync on or off, test and sync it, and delete it, but cannot swap in other credentials or choose the SSH key imported servers use.

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
- Roles: viewers browse and download, operators change objects and test the connection, admins manage connections and buckets (with custom roles: the `view`, `operate` and `manage` levels)

Uploads are capped by `SMT_STORAGE_MAX_UPLOAD_BYTES` (default 5 GiB).

## 📂 FTP / FTPS

Some hosts only speak FTP. Add one under **FTP** with a host, port, protocol and username/password. Explicit FTPS (TLS upgrade on port 21) is the default; implicit FTPS (port 990) and plain FTP are available for servers that need them, and certificate verification can be turned off for a self-signed box. The password is encrypted at rest with the same vault as SSH keys and never leaves the server.

- Browse from the account's login directory or a configured start directory
- Upload (streamed), download, create folders, rename, delete a file or a whole tree
- Roles: viewers browse and download, operators change files and test the connection, admins manage connections (with custom roles: the `view`, `operate` and `manage` levels)
- One logged-in session per user per connection, reused across requests and closed after two minutes idle

Uploads are capped by `SMT_FTP_MAX_UPLOAD_BYTES` (default 1 GiB).

**SFTP connections** also verify the server's host key (pinned on first use, or scanned and pinned by an admin beforehand) and can log in with one of the org's SSH keys instead of a password (a retired key is refused, and a key still used by a connection cannot be deleted). **Restrict to start directory** (on by default for new connections) keeps every path inside the start or login directory; on SFTP symlinks are resolved before each operation, and refusals are audited as `ftp.path_refused`. Recursive deletes over SFTP stop at 64 levels or 10,000 entries. A single SFTP request, or a stalled transfer, fails after `SMT_SFTP_OP_TIMEOUT_MS` (default 30000).

---

## 🩺 Connectivity diagnostics

**Diagnose** on a server, FTP/SFTP or storage connection (and offered when a terminal fails to connect) runs the checks one by one and stops at the first failure: DNS, TCP, TLS or the protocol banner, the host key against the pinned one, and — only when you tick it — a login with the stored credentials. Each failed step says what to check next, including firewall rules to paste with this app's egress IP, which is also shown under **Settings**. Operators and up can run it (per-server access applies), each run is audited, and runs are limited to 10 a minute per user. Behind a jump host the network checks target the first hop and the host key and login go through the chain; behind an agent they run over its tunnel.

The egress IP is looked up from `SMT_EGRESS_IP_SERVICES` (default `https://api.ipify.org,https://ifconfig.me/ip`, cached 10 minutes). Set `SMT_EGRESS_IP` to a fixed address (e.g. a NAT gateway the echo services cannot see), or to `off` to never look it up.

---

## 🎥 Session recording

Every terminal session and one-shot command run (saved commands, AI-run commands) is recorded in [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/) format, gzipped when it ends. **Recordings** lists them with filters; the player replays the output with idle gaps shortened, and the command log jumps to each command. Admins and owners see the whole org's recordings, everyone else only their own, and never one on a server they cannot access. Views and downloads are audited.

Owners set, on the Recordings page, whether recording is on (default on), whether keystrokes are captured too (default off — they can contain passwords typed at prompts), and how long recordings are kept (default 90 days, pruned daily). Only owners can delete a recording, with a passkey confirmation when they have one.

Recordings are files under `SMT_RECORDINGS_DIR` (default `/data/recordings`, inside the data volume), capped at `SMT_RECORDING_MAX_BYTES` (default 50 MiB uncompressed) each. They are **not** part of the database backups; back that directory up separately if you need them. If the directory cannot be written, sessions still open, unrecorded, and the error is logged.

---

## 🪜 Jump hosts and private networks

**Jump hosts.** An admin can pick another server of the org as a server's **Jump host** in the server form, like `ssh -J`; chains of up to 3 hops work. Every connection — terminal, commands, cron jobs, file browser, health checks, host key scans and diagnostics — connects to each hop with that hop's own credentials and host key check, then to the target over a tunnel with the target's host key check. Using a server does not require access to its jump host; each hop is audited as `server.jump`. When a hop fails, only admins and members who can access that jump server see which host failed and why; everyone else is told "The route to this server failed at hop N" (hops counted from the app outwards), and background health checks store that generic message too. The full error is always in the server log, and an admin's **Diagnose** shows it. Deleting a jump host makes the servers behind it connect directly.

**Connectivity agents.** For servers with no inbound SSH reachable from the app, an admin creates an agent under **Agents**. The install command shown once installs a small Node.js (18+) service under systemd on a host in that network, which keeps an outbound WebSocket to `SMT_BASE_URL` open. It downloads the installer to a temporary file and runs it as root with the agent's token on stdin from a here-doc, so the token never appears in a process's arguments (`ps`); the installer writes it to `/etc/bastion-agent/agent.env` (root-only, mode 600), which the systemd unit loads with `EnvironmentFile=`. The installer refuses to be piped into `sh` and ignores a token in the environment. The here-doc is still saved in an interactive shell's history like any pasted command; to keep it out, run `sudo sh install.sh` on its own and paste the token at its prompt, which does not echo. Pick the agent as the server's route in the server form; the app then reaches the server's SSH port through the agent. The agent only ever dials its own loopback (`127.0.0.1`) on the ports listed in `BASTION_ALLOWED_PORTS` (default 22), and it is treated as untrusted transport: host keys are still verified end to end, so pin the server's fingerprint up front where you can. A server uses either a jump host or an agent, not both (a jump host may itself sit behind an agent). Revoking an agent drops its connection at once, and its servers fail closed rather than connecting directly. Agent connections live in the app process, so cron jobs run by a separate worker cannot use them.

## 🐳 Docker on your servers

**Docker** on a server card opens its containers, images, volumes and networks, with engine version, API version, disk usage and live status. Clicking a container opens its logs (follow, search, timestamps, download), live CPU and memory, its environment and the full inspect output. Lists update live from the engine's event stream while the page is open.

Nothing is installed on the server and no port is opened: the app reaches the Docker socket through the server's own SSH connection — a forwarded Unix socket, or `docker system dial-stdio` over an exec channel when sshd does not allow socket forwarding (OpenSSH's `AllowStreamLocalForwarding` and `AllowTcpForwarding` both apply). Host key checks, jump hosts and agents work as for terminals. Docker is found on first use: the default `/var/run/docker.sock`, rootless Docker under `$XDG_RUNTIME_DIR`, then Podman's Docker-compatible socket; admins can set a socket path or turn Docker off per server in the server form, and **Detect Docker** probes again. When it cannot be reached the tab says why — not installed, daemon not running, forwarding disabled, or the SSH user not allowed on the socket (with the `usermod -aG docker <user>` fix). **Diagnose** with login checks Docker too.

Access to the Docker socket is root-equivalent on the server, and the UI says so. Everyone who can access a server can list its containers; logs, stats, `top` and inspect need the operator role, since logs routinely carry tokens and personal data. Environment values in inspect output are shown as `KEY=••••` unless an admin reveals them (below). Owners and admins set, under **Settings → Docker**, whether operators may open shells in containers (default on) or remove containers and images (default off), and whether pruning is allowed (default on) — these apply as the actions arrive. Per-server access, suspensions and time-limited grants apply as everywhere else, and revoking access closes the member's Docker connections and streams at once. Each member may keep 8 log/stats/event streams open at a time; log tails are capped at 10 000 lines.

**Actions.** Operators start, stop, restart, pause, unpause and kill containers from the list or the container drawer; stop, restart, kill and remove ask first, naming the container. Removing containers and images is for admins unless the org lets operators do it. **Pull image** streams progress per layer (public images, or registries the server is already logged in to; the reference is checked against Docker's grammar first) and closing the dialog cancels the pull. **Prune…** (admins, when the org allows it) shows a dry run first — stopped containers, dangling or all unused images, unused anonymous volumes, unused networks — then what was reclaimed. An admin can **Reveal values** of a container's environment after confirming a passkey (an admin without one must add one first). Every action, pull, prune and reveal is in the audit log against the server, naming the container or image; a reveal logs the variable names, never their values.

**Shells in containers.** **Open shell** starts `/bin/bash` in a running container, or `/bin/sh` when it has no bash, and opens it in the terminal (headed "container *name* on *server*"). It is a terminal session like any other: recorded under the org's recording settings (as a *container* recording naming the container — the Recordings page filters by container), closed when the tab is gone for a minute, and closed at once when the member's access is revoked, they are demoted, or the org stops letting operators open shells. Closing it sends ^C ^D so the shell exits rather than lingering in the container. Opening and closing are audited, with the exit code.

The **Compose** tab lists Compose projects found from their containers' labels, with each service's containers and state. Operators and up can run `up -d`, `restart`, `pull` and `down` on a project (after a confirmation naming it) and watch the CLI's output live; logs of the whole project are merged with a `web-1 |` prefix per container. Actions run `docker compose` on the server, in the project's recorded working directory with its recorded compose files, so the Docker CLI with the Compose plugin must be installed there. Label values are never interpreted by the shell. An action keeps running if you close the dialog, and each one is audited with its exit code. A project taken down has no containers left, so it disappears from the list until it is started again on the server.

**Containers** in the sidebar lists containers across every server you can access where Docker was found, searchable by name, image or Compose project and filterable by state and server; a row opens the container on its server's Docker page. Servers are asked five at a time with 10 seconds each, so one slow or unreachable server shows as an error below the table instead of holding up the page; servers nobody has opened the Docker page of yet are listed with a **Check them** button. The AI assistant can list containers, read the last lines of a container's logs (at most 500) and inspect a container — always with environment values redacted, and logs and inspect only for operators and up, as in the UI; each read is audited as `ai.docker_read`. Anything that changes a container goes through `run_command` and needs your approval. Under **Settings → Docker**, owners and admins can turn on container alerts (off by default): the health check then also samples containers on servers where Docker was found, over the same SSH connection, and alerts through your notification channels when a container is unhealthy, restarted three or more times within 10 minutes, or exited with an error while its restart policy says it should be running (a plain `docker stop` does not count). Each container gets its own alert and its own paging incident.

---

## 🚢 Deployments

Deploy web apps — Next.js, anything with a Dockerfile, or a static site — to your own servers, without Git and without BastionSSH keeping any of it. The server is the source of truth: each app's config, secrets, releases and the proxy config are files there, and `bastionctl` on the server does the work, so a deploy runs the same from BastionSSH or from a shell (`ssh server /opt/bastion/bin/bastionctl deploy site1 --source site.tar.gz`). BastionSSH only uploads, streams the log, and records who did what in the audit log ([design](docs/superpowers/specs/2026-10-05-server-deployments-design.md)).

**Set up** on a server's Deployments tab needs Docker on the server and an SSH user that may use it (docker group, or passwordless `sudo docker`). It installs `bastionctl` (one file, checked against the copy this BastionSSH ships before every use — a modified one is refused until you reinstall), creates the private `bastion-apps` network and the proxy. Deployments live in `/opt/bastion` when the SSH user can write it (created with passwordless `sudo` when allowed), otherwise in `~/bastion`:

```
/opt/bastion/
  bin/bastionctl, bin/bastionctl.mjs, bin/bastion-nginx
  proxy/Caddyfile                 # generated from every app; never edit
  proxy/data/ proxy/config/       # Caddy's certificates and state
  proxy/mode                      # caddy or nginx, chosen at setup
  proxy/nginx/<app>.site          # nginx mode: what the host helper builds server blocks from
  apps/<app>/
    bastion.yml                   # the app's config
    .env                          # secrets (0600), given to the container at start
    releases/<id>/                # source, build.log, release.json
    current -> releases/<id>
```

**Deploying.** Upload the source (a `.tar` or `.tar.gz`); the server unpacks it (every path checked), builds the image `bastion-<app>:<release>`, starts it next to the running one, waits for its health check, switches the proxy, then stops the old container. A failed build or health check leaves the previous release serving. **Rollback** serves a kept release's image again without rebuilding. Only one image builds per server at a time; other deploys wait their turn.

### `bastion.yml`

```yaml
name: site1                         # a-z, 0-9 and -, at most 41 characters; the app's folder name
domains: [site1.com, www.site1.com] # at most 50; no two apps on a server may share one
redirect_www: apex                  # apex: www → apex · www: apex → www · none
tls: auto                           # see TLS below
build:
  type: nextjs                      # nextjs | dockerfile | static
  node: "20"                        # nextjs and static: Node.js version (default: .nvmrc, engines, else 20)
  dir: .                            # project folder inside the upload
  output: out                       # static only: the folder to serve after the build
run:
  port: 3000                        # what the app listens on (static: always 80)
  env_file: .env                    # in the app folder
  volumes: ["uploads:/app/public/uploads"]   # named volumes only, never host paths
  memory: 512m                      # optional limits
  cpus: 1
healthcheck: { path: /, timeout: 30s }
keep_releases: 5                    # 2–50; the current and previous release are always kept
proxy: caddy                        # caddy | nginx — must match how the server was set up
```

Unknown keys are refused, and the editor shows every problem at once. Next.js apps need `output: 'standalone'` in `next.config.js`; the build explains how if it is missing.

### Caddy or nginx

| | Caddy (default) | nginx mode |
| --- | --- | --- |
| For | servers with nothing on ports 80/443 | servers that already run nginx for other sites |
| Ports 80/443 | the `bastion-caddy` container | your nginx; `bastion-caddy` listens on `127.0.0.1:18480` only |
| Certificates | Caddy, automatically, renewed by Caddy | `certbot certonly --webroot`, renewed by certbot's timer, which reloads nginx |
| What changes on the host | nothing outside the deployments folder | only `/etc/nginx/conf.d/bastion-<app>.conf` (`/etc/nginx/http.d/` on Alpine), one file per app |
| TLS options | all below | `auto` and `staging` |

Setup picks nginx mode by itself when an nginx on the host owns port 80 or 443 (and keeps whichever mode a server was set up with). In nginx mode every app still goes through `bastion-caddy`, so zero-downtime switches, health checks and rollbacks work the same; nginx terminates TLS and forwards each app's domains to it. Its server block only changes when an app's domains do, and it is written by `bastion-nginx`, a small script that is the only thing BastionSSH runs as root. Install it once, root-owned, and allow just that command — the Deployments tab shows these lines with your server's paths and user, and lists only what is still missing:

```sh
sudo apt-get install -y certbot      # if certbot is not installed
sudo install -o root -g root -m 0755 /opt/bastion/bin/bastion-nginx /usr/local/sbin/bastion-nginx
echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/bastion-nginx' | sudo tee /etc/sudoers.d/bastion-nginx
sudo chmod 0440 /etc/sudoers.d/bastion-nginx
```

The helper runs `nginx -t`, `nginx -s reload`, `certbot certonly --webroot` (and `certbot delete` when an app is deleted) — nothing else — and puts the previous server block back when `nginx -t` or the reload fails, or when `nginx -t` reports one of the app's domains as already claimed by another server block on the host (a site you serve yourself is never taken over). It reads only the checked values of `proxy/nginx/<app>.site`, and BastionSSH checks it is byte for byte the shipped copy before each use. `/etc/nginx/nginx.conf` must include `/etc/nginx/conf.d/*.conf` in its `http { }` block (the default on Debian and Ubuntu; on Alpine the blocks go to `/etc/nginx/http.d/`, which its default config includes there). The server block of an app that is no longer served — deleted with `bastionctl` from a shell, say — is removed by the next `apply` of any app; its certificate stays until `bastion-nginx remove`. Caddy keeps the `X-Forwarded-For` of requests from your nginx only; anything else reaching it has the header replaced by its own address. The server block sets `X-Forwarded-For` to the address nginx saw (`$remote_addr`, which your `real_ip` settings adjust if a CDN is in front), never one a client sent; existing server blocks pick this up at their app's next apply. From a shell: `sudo bastion-nginx apply /opt/bastion site1`, `sudo bastion-nginx status site1`.

### Several sites on one server

Each app is its own folder, container and image, all behind the one proxy, which routes by domain. A domain belongs to one app (a second app claiming it is refused), each app has its own `.env` and volumes (`bastion-<app>.<name>`), and a deploy or rollback of one app reloads the proxy without touching the others. Nothing but the proxy publishes a port.

### Domains and TLS

| `tls:` | Certificate | Needs |
| --- | --- | --- |
| `auto` | Let's Encrypt, obtained and renewed automatically | DNS pointing at the server, ports 80 and 443 open to the internet |
| `staging` | Let's Encrypt's staging CA — not trusted by browsers; for testing without hitting rate limits | as `auto` |
| `internal` | Caddy's own CA, for private names and intranets | nothing; browsers need Caddy's root installed to trust it |
| `dns:<provider>` | via the DNS provider's API — the only way to get wildcards (`*.site1.com`) | the API token in `/opt/bastion/proxy/.env` as `<PROVIDER>_API_TOKEN` (never in BastionSSH), and a Caddy build with that provider's DNS module — the pinned standard image has none yet |
| `{ cert: cert.pem, key: key.pem }` | your own files, in the app folder | renewing them yourself |

**Domains** on an app checks each domain now: its A/AAAA records against the server's public address (with the exact record to create when they do not match — a domain is saved either way), whether ports 80 and 443 answer from BastionSSH for `auto`/`staging`, and each certificate's issuer, expiry and last issuance or renewal error, read from Caddy (or from certbot through the helper in nginx mode). A certificate that is past its renewal point, has a renewal error logged, or has expired raises a **Certificate not renewing** alert through your notification channels — once when it starts, and again when it recovers. The state is worked out from the server whenever certificate status is read (opening Domains, or the API); BastionSSH stores none of it and does not poll on its own.

### Sizing

- **Builds run on the server.** A Next.js build wants about 1–2 GB of memory on its own; on a 1 GB server add 2 GB of swap or builds may be killed. Static and Dockerfile builds depend on the project.
- **Running apps**: Caddy uses a few tens of MB; a Next.js standalone server typically 100–300 MB, a static site served by Caddy a few MB. Set `run.memory` so one app cannot starve the others.
- **Disk**: each kept release keeps its image (often 150–500 MB for Node apps; layers are shared between releases of an app). `keep_releases: 5` with a few apps fits comfortably in 20 GB; lower it on small disks.
- As a rule of thumb: 1 vCPU / 1 GB for a few static or small Dockerfile sites, 2 vCPU / 2–4 GB to build and run several Next.js apps.

Permissions follow the **Deployments** module and your access to the server: view sees apps, releases, status and domains; operate deploys, rolls back, restarts and stops; manage sets up, edits `bastion.yml` and `.env` (values are write-only; revealing one needs a passkey and is audited), and deletes apps.

---

## ☸️ Kubernetes

**Kubernetes** in the sidebar lists your clusters, each with a health dot from its last test or use. A cluster opens on its **map**: one card per node with its role, whether it is ready or cordoned, any memory/disk/PID pressure, CPU and memory bars (what pods asked for, and what they really use when the cluster has metrics-server), and the node's pods as small tiles — green running, amber pending or starting, red failing (CrashLoopBackOff, Error, OOMKilled…), grey completed, purple terminating. Hover a tile for the pod's name, namespace, restarts and reason; click it for the pod's panel. Pods no node can take wait in a separate **Waiting for a node** lane with the scheduler's reason ("0/3 nodes are available: Insufficient cpu"). Picking a namespace dims everything outside it, and the choice is remembered per cluster. **Workloads** lists Deployments, StatefulSets, DaemonSets, Jobs and CronJobs with a health dot and a one-line summary ("2 of 3 ready"). Every object has its own panel — health, key facts, labels and what it is connected to (its owner, the pods it runs or sends traffic to), each a link — at a stable URL you can share. Operators and up also get a read-only YAML view. Everything updates live while the page is open; nothing needs `kubectl`. (The [design](docs/superpowers/specs/2026-10-03-kubernetes-visual-design.md) explains the choices behind all of it.)

**Understanding what is wrong.** The **Apps** tab draws how each app is wired, left to right: Ingress → Service → Deployment, StatefulSet, DaemonSet or CronJob → its pods, with the ConfigMaps, Secrets (by name — never their values), volume claims and autoscalers it uses alongside. Every line is a real relationship (an Ingress rule, a Service's selector matching pod labels, ownership, a volume or environment reference); boxes are coloured by health with a red badge counting problems, and a line that leads nowhere — an Ingress to a Service that does not exist, a Service whose selector matches no ready pod, a missing ConfigMap — is drawn dashed red, with the reason underneath. A workload's pods are a ring showing ready/desired in their colours; click it to see each pod. Big namespaces can be narrowed to one app. Click anything to open its panel, which now leads with **what's wrong in plain words** — "The app starts and crashes repeatedly (exit code 1). Check its logs — last lines shown.", "No node has room: needs 2 CPU, largest free is 0.5 CPU.", "This Service selects `app=web` but no ready pods match — traffic goes nowhere." — each with the likely cause, the next step and the evidence (the objects, events and facts it rests on). Deployments show their **rollout timeline** (revisions with image and change-cause, the current one highlighted, replicas as a bar during a rollout); pods show their lifecycle and containers (see **Inside a pod** below). The Map tab opens with **Needs attention**: every problem across namespaces, most severe first, a workload's failing replicas as one line. **Events** is the timeline of what Kubernetes reported, grouped by object, warnings highlighted, repeats collapsed ("Back-off restarting failed container ×37 in 20 min"). **Storage** draws each volume claim as a chain — the workloads that mount it → the claim → the volume holding the data — green when it has storage, amber while it waits for its first pod, red with the reason when nothing will provision it, plus the storage classes (which is the default, whether it keeps data after a claim is deleted) and volumes no claim holds. **Config** lists ConfigMaps and Secrets by name and key name only — never a value — with the workloads that read each one as files or environment variables, and calls out in red any a workload needs that does not exist. All of it updates live, and none of it needs AI — the explanations are rules over what the cluster reports. Operators and up also see the crashed container's last log lines in its diagnosis.

**Overview, Explain and alerts.** **Overview** on the Kubernetes page shows every cluster you can use side by side: its nodes as small squares (red when not ready), its pods as one bar in the map's colours, its workloads by health, the few things that most need attention (each a link to the object) and any open alerts. Clusters are asked five at a time with 10 seconds each, so one that is down shows as a grey card with the reason instead of holding up the page. On any object's panel, anyone who may operate where the object lives — operators, or a member whose role lets them operate in that namespace — gets an **Explain** button: BastionSSH sends the object (Secret values removed), its recent events, the state of its troubled pods and — for a crashing container — the last log lines of its previous run to your AI provider, and shows the plain-language answer with a line saying exactly what was sent. The AI assistant can also read clusters — list workloads, describe an object, read events and the last lines of a pod's logs (at most 500) — under the same rules as the UI, each read audited as `ai.kube_read`; it never changes a cluster. The assistant is for operators and up, and for anyone a custom role or personal grant lets operate at least one server or cluster namespace; every tool still checks the level on its own target, so it runs commands only where you could open a terminal. Others do not see the **AI Assistant** link. Under **Settings → Kubernetes**, owners and admins can turn on cluster alerts (off by default): after each health check, BastionSSH alerts through your notification channels when a cluster cannot be reached three times in a row, a node is not ready, a Deployment, StatefulSet or DaemonSet has no ready replicas, pods crash-loop (or restart three or more times within 10 minutes), or pods stay pending for more than 10 minutes. Pod alerts are grouped by the workload that owns them, and each gets its own paging incident.

**Adding a cluster** (admins): upload a kubeconfig and pick a context, or enter the API server URL, its CA and a service account token (or a client certificate and key). Then choose how BastionSSH reaches the API server:

- **Directly** — the API server URL must be reachable from the BastionSSH host (private addresses are fine; cloud metadata and link-local addresses are refused).
- **Through a server** — for private clusters: BastionSSH opens an SSH connection to a server you already manage (host key checks, jump hosts and agents apply) and tunnels to the API server from there. The server's sshd must allow TCP forwarding (`AllowTcpForwarding yes`, the OpenSSH default). Use the API server's address as that server sees it.
- **Through an agent** — when a connectivity agent runs on a control-plane node: add the API port (usually 6443) to the agent's `BASTION_ALLOWED_PORTS`, and use an API server URL whose name is on the certificate (e.g. `https://kubernetes.default.svc:6443` or the node's name).

**Test connection** checks each step in turn — reach the port, TLS, the credential, `/version` — and then asks the cluster what the credential may do (see pods, follow changes, read logs, scale, delete pods, open a shell, cordon nodes, impersonate…), so you see at once whether the map will be empty. TLS is always verified against the cluster's CA (or the system trust store for clusters with a public certificate), with the API server's name checked even through a tunnel; `insecure-skip-tls-verify` is refused. Kubeconfig entries that would run a program on the BastionSSH host — `exec` plugins (`aws eks get-token`, `gke-gcloud-auth-plugin`, `kubelogin`) and `auth-provider` — are refused too: create a service account token instead (below). Files referenced by path must be embedded (`kubectl config view --minify --flatten --context <name>`). The credential is encrypted and never shown again; the UI shows "token ending …abcd" or the certificate's name. It is only ever sent to the API server it was saved for: changing a cluster's address or CA needs the credential entered again.

**Who sees what.** Everyone with access to a cluster sees the map, workloads and details. Secret values never leave the server: Secrets show their type and key names only, and environment variables that come from a Secret show the reference, not the value; opening a Secret's (redacted) YAML is audited. ConfigMap values are shown unless an owner or admin turns that off under **Settings → Kubernetes**, where they also choose whether operators may scale and restart workloads, delete pods and open shells (all on by default). Restricted members see only the clusters granted to them in the Team **Access** dialog, permanently or for a time, like servers; a cluster's **namespace allowlist** limits what anyone sees on it. A member whose access is narrowed to some namespaces sees only those (not the rest of the allowlist) and not which server or agent the cluster is reached through — an error reaching it through one just says the cluster could not be reached. Where a role lets a member do more in a namespace than on the cluster as a whole, an object's panel there offers what they may do (Logs, YAML, shells, actions, Explain). A request for access to a cluster can name namespaces, and the admin approving it can narrow them further (or narrow a whole-cluster request); only those namespaces are granted. Approved at your base role's level, such access follows your role if it changes before it ends. Revoking access closes a member's live views at once. The cluster's own credential bounds everything: BastionSSH roles decide what the UI offers, Kubernetes RBAC decides what is possible. With **impersonation** on (off by default), every request carries `Impersonate-User: bastion:<email>` and `Impersonate-Group: bastion:<role>`, so the cluster's RBAC and audit log see the real person — the credential needs the `impersonate` verb for that, and you bind roles to those users and groups. **Diagnose** on a cluster runs DNS, TCP and TLS checks on its route (or the SSH checks of the server it goes through) and then the connection test.

**Guided actions** fix the common problems with a button instead of a command. A Deployment or StatefulSet panel has a **scale** slider whose rings show the replicas now → after as you drag (pods that start in blue, pods that stop in red), with a warning when a HorizontalPodAutoscaler controls the workload and will change the count back; **Restart rollout** replaces every pod one by one (the confirmation warns when the workload's update strategy is `Recreate`, which stops them all at once, or `OnDelete`, which replaces nothing until pods are deleted). A Deployment's **revisions** are a timeline — when, the change-cause, the images, the one running now highlighted — and admins can **roll back** to a past one after seeing what changes (images, and environment variable *names* added or removed; values never leave the cluster). A pod with an owner offers **Restart this pod** (it is deleted and its controller starts a fresh one); a pod without one — or one whose Job already finished — gets a stronger warning, since nothing brings it back. Admins **cordon / uncordon** a node with the switch on its map card, in the Nodes table or in its panel — no new pods are placed there, the ones already there keep running. A CronJob can be **suspended / resumed** with a switch, or **run now** (a Job from its template, owned by the CronJob, under a generated name). Every action asks first, naming the object, and has a collapsible **What this does** with the equivalent `kubectl` command for learning — nothing runs it; BastionSSH sends the same minimal patch to the API server itself. Operators may scale, restart, run and suspend CronJobs and delete pods unless the org turns that off under **Settings → Kubernetes**; rolling back and cordoning are for admins. Each action is audited with the cluster, namespace, kind, name and the before/after of what it changed, and the cluster's RBAC can still refuse it (the reason is shown).

**Inside a pod.** A pod's panel draws where it is in its life — **Scheduled → Initialized → Started → Ready**, with the step it is stuck at in red and the cluster's reason ("worker: CrashLoopBackOff") — and then its containers as **lanes** in the order they run: init steps one after another, native sidecars, the app containers, debug containers. Each lane shows the container's state in a word and a colour, its restarts, how its previous run ended (OOMKilled, exit 137…), and **CPU and memory bars**: live usage (with metrics-server) against its limit, a dashed tick at what it asked for, amber near the limit and red at it. Operators and up get a **Logs** tab — pick a container, follow new lines, switch to the **previous run** to see why it crashed, search (matches are marked), choose how much history, and download as text — and the read-only **YAML** with line numbers and search. **Open shell** (operators when the org allows it, admins always) starts a shell in a running container — bash if it has it, else sh — over the Kubernetes exec WebSocket on the same verified route as everything else. It opens in the terminal page like a server shell, resizes with the window, is recorded when the org records sessions (listed under **Recordings** as "Shell in pod" with the cluster, namespace, pod and container), audited when it starts and ends with its exit code, and closed as soon as the member loses the cluster, the role, or the org's **operators may open shells** switch. Logs are what the container printed and are not redacted, which is why they need the operator role.

### A least-privilege service account

Give BastionSSH its own service account rather than an admin kubeconfig. A read-only ClusterRole is enough for everything available today:

```yaml
# bastion-viewer.yaml — kubectl apply -f bastion-viewer.yaml
apiVersion: v1
kind: Namespace
metadata: { name: bastion }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: bastion-viewer, namespace: bastion }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: bastion-viewer }
rules:
  - apiGroups: ["", "apps", "batch", "networking.k8s.io", "storage.k8s.io", "autoscaling"]
    resources: ["*"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["metrics.k8s.io"]
    resources: ["pods", "nodes"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: bastion-viewer }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: bastion-viewer }
subjects: [{ kind: ServiceAccount, name: bastion-viewer, namespace: bastion }]
---
# A token that does not expire (delete the Secret to revoke it). For a token that
# expires instead: kubectl -n bastion create token bastion-viewer --duration=8760h
apiVersion: v1
kind: Secret
metadata:
  name: bastion-viewer-token
  namespace: bastion
  annotations: { kubernetes.io/service-account.name: bastion-viewer }
type: kubernetes.io/service-account-token
```

Secrets are readable by this role so their names and keys can be listed; BastionSSH strips the values before anything reaches a browser. To keep even that away from it, replace `"*"` in the first rule with an explicit list of resources that leaves out `secrets`. For the guided actions, bind a separate Role per namespace you want them in (scale, restart, roll back, delete pods, CronJobs):

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: bastion-operate, namespace: shop }
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets", "deployments/scale", "statefulsets/scale"]
    verbs: ["patch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["delete"]
  - apiGroups: ["batch"]
    resources: ["cronjobs", "jobs"]
    verbs: ["patch", "create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: bastion-operate, namespace: shop }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: bastion-operate }
subjects: [{ kind: ServiceAccount, name: bastion-viewer, namespace: bastion }]
```

Cordoning patches nodes, which are not in any namespace: it needs a ClusterRole with `patch` on `nodes` (core group), bound with a ClusterRoleBinding — leave it out to keep BastionSSH from touching nodes.

Pod logs need `get` on `pods/log`, and shells `create` (and, on older clusters, `get`) on `pods/exec` — add them to this Role, or a separate one, where you want them. Note that `resources: ["*"]` with `get` in the viewing role above already covers `pods/exec`, and Kubernetes versions without the newer `create` check for WebSocket exec authorize a shell with `get` alone: if the credential must not open shells, list the viewing role's resources explicitly instead of `"*"`.

Then collect the three things the **Add cluster** form needs:

```bash
TOKEN=$(kubectl -n bastion get secret bastion-viewer-token -o jsonpath='{.data.token}' | base64 -d)
kubectl -n bastion get secret bastion-viewer-token -o jsonpath='{.data.ca\.crt}' | base64 -d > ca.crt
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'   # the API server URL
```

Per platform:

- **EKS** — your kubeconfig uses `aws eks get-token` (an exec plugin), so apply the YAML above with it and use the service account token; EKS accepts Kubernetes service account tokens. The URL and CA are also in `aws eks describe-cluster --name <c> --query 'cluster.[endpoint,certificateAuthority.data]'` (the CA is base64). For a private endpoint, connect through a server or bastion inside the VPC.
- **GKE** — the kubeconfig uses `gke-gcloud-auth-plugin`; same approach. URL and CA: `gcloud container clusters describe <c> --format 'value(endpoint,masterAuth.clusterCaCertificate)'` (prefix the endpoint with `https://`; the CA is base64). Private clusters: through a server or bastion with access to the control plane.
- **AKS** — Entra ID kubeconfigs use `kubelogin` (an exec plugin); use the service account token. The URL and CA are in `az aks get-credentials --file -` output (`server`, `certificate-authority-data`). For a private cluster, connect through a server in the cluster's VNet.
- **k3s** — `/etc/rancher/k3s/k3s.yaml` on the server node embeds a client certificate and works as is (it is cluster-admin, so prefer the token above); replace `https://127.0.0.1:6443` with the node's address, or connect **through** that node as a managed server and keep `https://127.0.0.1:6443`. When adding names or IPs, start k3s with `--tls-san` for them so the certificate covers the URL you use.
- **kind** — `kind get kubeconfig --name <c>` embeds a client certificate and points at `https://127.0.0.1:<port>` on the host running Docker; use it directly when BastionSSH runs on that host, or through that host as a managed server.

---

## 🔁 SSH key rotation

**Rotate** on a server (or several at once from **SSH Keys**) generates a new key, adds it to `~/.ssh/authorized_keys` keeping the old line's options, proves a login with it, switches the server over, and removes the old key — rolling back at whichever step fails. A key still used by other servers on the same account, a cloud account or an SFTP connection is left in place and not retired; otherwise it is retired and refused from then on. Rotation is admin-only, needs a passkey confirmation when the admin has one, and every step is recorded in the rotation history and the audit log. Keys older than 180 days are flagged in the UI. Short-lived SSH certificates are not supported yet; see [docs/ssh-certificates.md](docs/ssh-certificates.md).

---

## 👥 Collaboration

Work as a team without sharing SSH keys over Slack ever again.

- **Organizations & workspaces** — Group your team under a shared environment.
- **Roles & permissions** — `Owner`, `Admin`, `Operator`, `Viewer`. Fine-grained access per server, key, command, or cron job.
- **Time-limited access** — Members restricted to some servers can request others for a reason and a duration (up to 8 hours by default, configurable). An admin other than the requester approves, optionally for less time, or denies. A suspended member's request cannot be approved, and suspending or removing a member cancels their pending requests. Access ends by itself: expired grants stop working immediately, and open terminals and file sessions on them are closed within a minute. Admins can also grant time-bound access directly. By default restricted members can see the *names* (only) of servers they cannot use, so they know what to ask for; an org setting turns this off, and then they can only extend access they already have.
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

**HTTPS with the bundled Caddy.** `deploy/docker/docker-compose.yml` has an opt-in `https` profile that adds [Caddy](https://caddyserver.com) in front of the app. Caddy obtains and renews a certificate for your domain automatically and proxies to the app; without the profile nothing changes (plain HTTP on port 8080). Point the domain's DNS at the host, open ports 80 and 443, then put this in `deploy/docker/.env`:

```bash
SMT_DOMAIN=bastion.example.com            # the public hostname
SMT_BASE_URL=https://bastion.example.com  # must be https://$SMT_DOMAIN — passkeys are bound to this hostname
SMT_TRUST_PROXY=1                         # client IPs come from Caddy's X-Forwarded-For
SMT_HTTP_BIND=127.0.0.1:8080              # keep the plain-HTTP port off the network
SMT_ACME_EMAIL=ops@example.com            # optional: certificate expiry notices
```

```bash
cd deploy/docker
docker compose --profile https up -d
```

Caddy refuses to start (see `docker compose logs caddy`) until `SMT_BASE_URL` is `https://$SMT_DOMAIN`, `SMT_TRUST_PROXY` is set and `SMT_HTTP_BIND` is a loopback address: the first mistake breaks passkeys, the second puts every user behind one rate-limit bucket and one audit-log IP, and the third would let anyone reaching port 8080 directly claim any client address in `X-Forwarded-For`. Passkeys enrolled while the instance ran on `localhost` do not work on the domain (they are bound to the hostname), so enroll them after the switch.

**Storage backends:**

- **SQLite** (default) — zero-config, perfect for solo / small teams.
- **PostgreSQL** — recommended for teams of 5+ or HA setups.

**Authentication options:**

- Built-in email/password
- Passkeys (WebAuthn) — passwordless sign-in, or a second step after the password
- Single sign-on per organization over OpenID Connect (Google Workspace, Microsoft Entra ID, Okta, generic OIDC)
- Optional 2FA (TOTP)

### Passkeys

Anyone can add passkeys under **Settings → Passkeys**. Once an account has one, signing in with the password also asks for it, and **Sign in with a passkey** on the login page works without the password. Owners can turn on **Team → Require passkeys for this organization**: members then have to have used a passkey in their current session to do anything in that org, and anyone without one is asked to create it right after signing in. Enabling it requires the owner's own session to be passkey-verified, so an owner cannot lock themselves out, and ends open terminals, file sessions and AI chats in that org for members who have no passkey-verified session. Under the policy only API tokens created from a passkey-verified session work; older tokens must be recreated.

A first passkey needs the account password again and a sign-in from the last 15 minutes; enrolling it signs out the account's other password-only sessions. Once an account has a passkey, changing the password, creating API tokens, and (for admins) issuing password-reset links or resetting someone's passkeys need a session that has used it. When SMTP is configured (`SMT_SMTP_URL`), people are emailed whenever a passkey is added to their account.

**Backup codes.** Once an account has a passkey, **Settings → Passkeys → Backup codes** generates ten one-time recovery codes (`XXXXX-XXXXX`, Crockford base32). They are shown once — copy or download them — and generating a new set invalidates the old one. When you sign in with your password, **Use a backup code instead** finishes the sign-in without the passkey. By default that session can only add a new passkey: every other request is refused (`403 RECOVERY_ONLY`) and the app opens **Settings → Passkeys**, and confirming with the new passkey lifts the limit, after which you can remove the lost one. Owners can turn this off under **Team & Access → Sign-in security**, giving backup-code sign-ins full access as before (changes are audited as `org.backup_code_policy`). Codes are case-insensitive and the dash is optional. They are not accepted for passwordless sign-in or to confirm a passkey (step-up), and a pending sign-in is dropped after five wrong codes. Generating codes needs a passkey-verified browser session; removing your last passkey, or an admin passkey reset, deletes them. Only an HMAC of each code (keyed from `SMT_SESSION_SECRET`) is stored, so rotating that secret invalidates every backup code. With SMTP configured, people are emailed when codes are generated and whenever one is used.

Lost passkey and no backup codes? An admin or owner who outranks the member can **Reset passkeys** on the Team page. That removes all of their passkeys and signs them out; they sign in with their password and enroll a new one. As with admin password resets, this is refused for someone who also belongs to another organization.

Browsers only offer passkeys on **HTTPS** pages or on **localhost**, and a passkey is bound to the RP ID (a domain), so choose it before your team enrolls:

```bash
SMT_WEBAUTHN_RP_ID=bastionssh.yourcompany.com   # default: hostname of SMT_BASE_URL
SMT_WEBAUTHN_RP_NAME=BastionSSH                 # shown in the browser prompt
SMT_WEBAUTHN_ORIGINS=https://bastionssh.yourcompany.com  # comma list; default: origin of SMT_BASE_URL
```

With `NODE_ENV=development` the Vite dev server (`http://localhost:5173`) is allowed too, unless `SMT_WEBAUTHN_ORIGINS` is set. Changing the RP ID later makes every existing passkey unusable.

### Backups & restore

The app keeps everything — accounts, servers, keys, encrypted credentials, audit log — in one SQLite file, `/data/smt.db`. It backs that file up itself, using SQLite's online backup API, so a backup is consistent even while the app is writing:

- **Scheduled** every `SMT_BACKUP_INTERVAL_HOURS` (default `24`; `0` turns it off). The timer checks the age of the newest scheduled backup, so restarts neither skip nor add one.
- **Before every upgrade**: when a new version is about to migrate an existing database, it backs it up first and refuses to migrate if it cannot (`SMT_BACKUP_PRE_MIGRATION=false` skips this).
- **Manual**: **Settings → Database backups → Back up now**, or `pnpm --filter @smt/server run db:backup` (`node apps/server/dist/cli/backup.js` in the Docker image).

Backups land in `SMT_BACKUP_DIR` (default `/data/backups`, i.e. inside the data volume) as `smt-<UTC time>-<scheduled|pre-migration|manual|pre-restore>.db`, or `.db.gz` with `SMT_BACKUP_GZIP=true`. The newest `SMT_BACKUP_KEEP` (default `14`) of each kind are kept. Files are owner-readable only (`0600`). Live sign-in sessions, pending passkey challenges and pending single sign-on round trips are stripped from every backup, and invite tokens are replaced, so a restored instance has everyone sign in again and pending invites must be sent again. The vault key (`SMT_ENCRYPTION_KEY`) is **not** in the backup — keep it somewhere safe too, or the credentials in a backup cannot be decrypted.

A backup in the data volume does not survive losing that volume. Either mount a different volume at `/data/backups`, or copy each new backup to object storage: add the bucket's provider under **Storage**, then set `SMT_BACKUP_STORAGE_CONNECTION_ID` (the id in that connection's URL), `SMT_BACKUP_STORAGE_BUCKET` and optionally `SMT_BACKUP_STORAGE_PREFIX` (default `bastionssh-backups/`). Scheduled and manual backups are uploaded after they are written, **encrypted** with a key derived from `SMT_ENCRYPTION_KEY` (as `<name>.enc`) — anyone in that connection's organization can browse the bucket in the app, so the upload is sealed. A failed upload is logged and audited but keeps the local copy. Old copies in the bucket are not pruned — use a lifecycle rule there. To restore one, copy the `.enc` file into the data volume and pass its path to the restore command; it decrypts with `SMT_ENCRYPTION_KEY` from the environment (already set in the compose file).

Owners of the instance's organization (the one created on first start) see **Settings → Database backups**, can take one and download any. Downloading needs a signed-in browser (not an API token) and, when the owner has a passkey, a passkey confirmation. Creating and downloading backups (and failed backups or uploads) are recorded in the audit log; viewing the list is not.

**Restoring** replaces the database, so the server must be stopped; the tool refuses while one is running (it keeps `smt.db.lock` fresh next to the database and checks the port). It checks the backup with `PRAGMA integrity_check` first, saves the current database as a `pre-restore` backup, then swaps the file in. With Docker Compose (from `deploy/docker`):

```bash
docker compose exec smt ls -l /data/backups                 # pick a backup
docker compose stop smt
docker compose run --rm --no-deps smt \
  node apps/server/dist/cli/restore.js smt-20260928T031500Z-scheduled.db
docker compose start smt
```

A bare name is looked up in `SMT_BACKUP_DIR`; a path works too (e.g. a backup you downloaded and copied into the volume). From source: `pnpm --filter @smt/server run db:restore -- <backup name or path>`. After a restore the server applies any newer migrations on start (taking a pre-migration backup of the restored database first).

### Single sign-on (OpenID Connect)

Owners set up SSO under **Team → Single sign-on**: pick Google Workspace, Microsoft Entra ID, Okta or any other OpenID Connect provider, enter its issuer URL (discovery is read from `<issuer>/.well-known/openid-configuration`), a client ID and secret (vault-encrypted, never shown again), and the email domains allowed to sign in. Register the redirect URI shown there — `SMT_BASE_URL` + `/api/auth/sso/callback` — as a web-application client at the provider. **Test discovery** checks that the discovery document and signing keys can be fetched; the client credentials are only proven by a real sign-in. Each org has one provider.

Members use **Sign in with SSO** on the login page and enter the org's slug or their work email. The flow is authorization code + PKCE; the state, nonce and PKCE verifier stay on the server for 10 minutes and the state is also bound to the browser by a cookie. The ID token's signature (against the provider's JWKS), `iss`, `aud`, `exp` and nonce are verified, and every sign-in needs a verified email (`email_verified`, or Entra's `xms_edov` optional claim) in an allowed domain — subdomains must be listed separately. With Google (`https://accounts.google.com`) the token's `hd` claim must also name an allowed domain, so personal Google accounts registered with a work address are refused.

- **Accounts.** An identity is remembered by the provider's `sub`. The first time, it is linked to an existing account with the same verified email only if that account is already a member of the org. Otherwise, with **Create accounts on first sign-in** on, a password-less account is created with the configured role (never owner); with it off, only existing members can use SSO. An account that exists but belongs only to other orgs is never taken over.
- **Group → role mapping** (optional). Name the ID-token claim that lists groups (Okta is asked for the `groups` scope) and map values to viewer/operator/admin; at each sign-in the highest mapped role replaces the member's role. Owners are never changed.
- **Require single sign-on.** Password and passkey sign-in stop working for members other than owners, who keep them as a break-glass way in if the IdP is down. Existing non-SSO sessions of those members are refused from their next request, and their open terminals and file sessions end. API tokens keep working.
- **SSO sessions are tied to the org.** A session that signed in through an org's SSO only works in that org, and — when the account belongs to other orgs too — cannot add passkeys, backup codes or API tokens (those work in every org). Such a session also lists and signs out only that org's SSO sessions under **Active sessions**: password and passkey sessions (which can switch to any org) and other orgs' SSO sessions are neither shown to it nor ended by it. Sign in with a password or passkey to manage every session of the account. Disabling or removing the provider, or pointing it at another issuer or client, signs out every SSO session; a new issuer or client also forgets the old identity links.
- **Passkey policy still applies.** An SSO sign-in is not passkey-verified, so in an org that requires passkeys the member is asked to create or use one after signing in. If you turn on **Trust phishing-resistant MFA reported by the provider**, a sign-in whose ID token says it used a hardware key (`amr` contains `hwk` or `fido`, or `acr` is `phr`/`phrh`) counts as passkey-verified. Only enable this if your IdP really enforces that; the claim is as trustworthy as the IdP.
- **Suspension** is checked at every SSO sign-in and request, as for passwords. Every sign-in, refusal, link, provisioned account and configuration change is audited.

Plain-`http` issuers are only accepted with `NODE_ENV=development`. **SAML is not supported**: the Node SAML libraries are either large or have a history of signature-wrapping vulnerabilities, and every provider listed above also speaks OpenID Connect.

### Sign-in alerts and lockout

- **New-device alerts.** Each account remembers the devices it signs in from — browser and OS family plus the client's network (/24 for IPv4, /48 for IPv6), stored as a hash. A sign-in from a new one is audited (`user.login_new_device`) and, with SMTP configured, emailed to the account. Browser updates and a changing address inside the same network do not count as new. **Settings → Known devices** lists them; forgetting one makes its next use alert again. Devices unused for 180 days are forgotten.
- **Failed passwords.** Five wrong passwords for one account within 15 minutes, from any mix of addresses, pause password sign-in for that account — 1 minute, then 2, 4, 8, up to 15 minutes for repeat pauses, reset after a quiet day. This is on top of the per-IP limit (10 sign-ins a minute). Each failure is audited (`user.login_failed`), each pause is audited (`user.login_locked`) and the owner is emailed (at most hourly). Unknown addresses are paused the same way, so the response does not reveal which accounts exist.
- **Why the pause is short:** anyone who knows an address can trigger it, so it must not become a way to keep someone out. **Signing in with a passkey is never paused and ends the pause**, as does an admin-issued password reset link.

### Audit log

**Audit Log** (admins) filters by date, action (`user.*` for a prefix) and actor, and exports every matching event as **CSV** or **JSON Lines** — `GET /api/audit/export?format=csv|jsonl&from=&to=&action=&actorEmail=&resourceType=&resourceId=` for scripts with an API token. Exports are streamed, oldest first, and are themselves audited. In CSV, cells starting with `= + - @` are prefixed with `'` so spreadsheets do not run them.

Owners set, on the same page:

- **Retention** — events older than this many days (default 365, 7–3650) are deleted by a daily job, which records how many it removed (`audit.pruned`).
- **Forwarding** — every new event is copied, within about half a minute, to one target per organization:
  - **Syslog** (RFC 5424) over UDP, TCP or TLS (RFC 6587 octet-counted framing). The event's key fields are structured data (`[bastionssh@32473 org=… actor=… action=…]`), the full event is JSON in the message. TLS verifies the collector's certificate for the hostname you enter; paste a CA bundle for a private CA.
  - **Webhook** — `POST`s JSON batches `{"source":"bastionssh","events":[…]}`. With a signing secret, each request carries `X-BastionSSH-Timestamp` and `X-BastionSSH-Signature: sha256=<HMAC-SHA256(secret, timestamp + "." + body)>`.

  Delivery is at-least-once: a batch is retried three times, then the target backs off (30 s doubling to 15 min) and nothing is skipped — the next attempt resumes where the last success stopped. Failures show on the page and the first one is audited (`audit.forwarding_failed`). Targets and secrets are encrypted at rest. Targets must resolve to public addresses — loopback, private, link-local and cloud-metadata addresses are refused, and the connection goes to the address that was checked — unless the operator allows an internal network with `SMT_AUDIT_FORWARD_ALLOW_NETS` (e.g. `10.20.0.0/16`); metadata addresses are refused regardless. Webhooks need HTTPS unless they point into such an allowed network. Changing retention or forwarding needs a passkey-verified session when the owner has a passkey.

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
- No telemetry. Outbound calls go only to what you configure (AI provider, notification channels, SSO, audit forwarding) plus the egress IP lookup used by diagnostics (`SMT_EGRESS_IP=off` disables it).
- Self-hosted — your data never leaves your infrastructure.

> ⚠️ For production deployments, serve over HTTPS: use the compose file's `https` profile (bundled Caddy, see above) or your own reverse proxy (Caddy, Nginx, Traefik) with TLS.

---

## 🛣️ Roadmap

- [x] SFTP / file browser
- [x] Multi-server command execution (fan-out: saved commands by server list or tag)
- [x] Server monitoring (CPU, memory, disk) with alert notifications
- [x] Connectivity diagnostics
- [x] Time-limited access requests (JIT)
- [x] Session recording and replay
- [x] Jump hosts and connectivity agents for private networks
- [x] Single sign-on (OIDC)
- [x] SSH key rotation
- [x] Audit log retention and forwarding (syslog, webhook)
- [x] App database backups (scheduled, pre-migration, optional encrypted off-site copy)
- [x] Docker: containers, images, volumes, networks, logs and stats (read)
- [x] Docker: container actions, exec shells, Compose, fleet view, AI tools and container alerts ([design](docs/superpowers/specs/2026-09-30-docker-management-design.md))
- [x] Kubernetes K1: connect clusters (direct, through a server, through an agent), live cluster map, workloads, redacted details ([design](docs/superpowers/specs/2026-10-03-kubernetes-visual-design.md))
- [x] Kubernetes K2: app topology graph, plain-language diagnoses, events timeline, "needs attention" list
- [x] Kubernetes K3: guided actions — scale, restart, roll back, delete pod, cordon, CronJobs — each with a preview and its equivalent command
- [x] Kubernetes K4: pod panel with container lanes, lifecycle and usage bars; logs (live, previous run, search, download); recorded shells over the exec WebSocket; read-only YAML
- [x] Kubernetes K5: AI Explain and read-only AI tools, opt-in cluster alerts, fleet overview across clusters
- [ ] Short-lived SSH certificates ([design notes](docs/ssh-certificates.md))
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

### Checks

CI (`.github/workflows/ci.yml`) runs these on every push and pull request; run them locally before opening one:

```bash
pnpm install
pnpm --filter @smt/shared --filter @smt/cron-parser --filter @smt/agent run build   # the server imports their dist/
pnpm typecheck
pnpm lint          # ESLint flat config in eslint.config.js
pnpm test          # vitest: server routes and cron-parser
pnpm test:e2e      # Playwright browser tests (below)
```

### Browser tests

`pnpm test:e2e` builds the server and web app, starts the built server on `http://localhost:18473` against a throwaway SQLite database (`NODE_ENV=test`, a fixed `SMT_ADMIN_PASSWORD`, monitoring and cloud sync off), serves the web build from it, and runs the Playwright suite in `apps/e2e` with Chromium. It covers password sign-in, passkey registration and sign-in (through Chrome's virtual WebAuthn authenticator), backup codes, the team invite flow, the AI command-approval card (against a stub OpenAI-compatible provider the test starts), the FTP form's SFTP option, and the Docker pages against a stubbed Docker API (confirmations for container actions and prune, container shells, Compose actions, the Containers fleet view), and the Kubernetes cluster list, cluster map and pod panel against a stubbed Kubernetes API, as well as the topology graph (node and edge counts, health colours, dashed broken links, replica rings), the diagnosis panel, the attention list, the events timeline and the Storage and Config tabs, the guided actions (the scale slider and its confirmation, restart warnings, a Deployment panel with its diagnosis, actions and revisions), the pod panel (lanes, logs, YAML, shells) and the Kubernetes overview and Explain.

- First time only: `pnpm --filter @smt/e2e exec playwright install chromium`
- Another port: `E2E_PORT=19000 pnpm test:e2e`
- Just the tests, against existing builds: `pnpm --filter @smt/e2e run test:e2e`, with any Playwright flags after it (e.g. `--headed`, `tests/02-passkeys.spec.ts`)
- Without `SMT_REDIS_URL` the server logs Redis connection errors from its idle queues; they are harmless here. Set `SMT_REDIS_URL` to a Redis you can throw away to silence them, as CI does.
- Reports and traces of failures land in `apps/e2e/playwright-report` and `apps/e2e/test-results`.
- `E2E_SCREENSHOTS=<dir>` saves the Kubernetes pictures the tests pass through (cluster map, topology graph, diagnosis panel, Storage and Config tabs, scale panel and confirmation) and the custom roles ones (role editor, a member's effective access, the access checker) as PNGs in that directory — the ones in [`docs/superpowers/specs/kubernetes-screenshots`](docs/superpowers/specs/kubernetes-screenshots) and [`docs/superpowers/specs/custom-roles-screenshots`](docs/superpowers/specs/custom-roles-screenshots) were made so.

### Live Kubernetes tests

The `*.integration.test.ts` files under `apps/server/src/kube` run against a real cluster and are skipped unless `SMT_TEST_KUBE_KUBECONFIG` is set. `apps/server/scripts/kube-it.sh up` starts a throwaway k3s server in Docker on port 26443 with a sample app that has known problems (a crash loop, an image that cannot be pulled, an unschedulable pod, a Service with no pods…), a read-only service account and an `openssh-server` container on port 22423 to tunnel through, writes the kubeconfig to a temp directory (never `~/.kube`) and prints the `SMT_TEST_KUBE_*` variables to export; then run `cd apps/server && pnpm vitest run src/kube --no-file-parallelism`, and `kube-it.sh down` removes the containers, their volumes, the network and the temp directory. `SMT_KIT_PREFIX`, `SMT_KIT_API_PORT` and `SMT_KIT_SSH_PORT` keep two runs apart.

---

## 📄 License

MIT © Contributors
