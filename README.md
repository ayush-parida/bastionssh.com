# Server Management Tool

> An open-source, **browser-based** tool to manage multiple SSH keys, multiple servers, and connect to them right from your browser — supercharged with your own AI model (OpenAI, Claude, or any local LLM).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker Pulls](https://img.shields.io/badge/docker-ready-blue)](#-installation)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#-contributing)

---

## ✨ Features

- 🌐 **100% Browser-Based** — Manage everything from a clean web UI. No desktop app, no terminal required.
- 🔑 **SSH Key Management** — Generate, import, organize, and rotate multiple SSH keys.
- 🖥️ **Server Inventory** — Add, tag, and group unlimited servers (production, staging, clients, personal, etc.).
- 💻 **In-Browser Terminal** — Full interactive SSH sessions in your browser via WebSocket + xterm.js.
- 📌 **Saved Commands per Server** — Save frequently-used commands against any server and run them with one click.
- ⏰ **App-Level Cron Jobs** — Schedule recurring commands that run **from the application** (not from the server's crontab). Keeps your servers untouched and gives you a single place to view history, logs, and failures.
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
  --name smt \
  -p 8080:8080 \
  -v smt_data:/data \
  ghcr.io/<your-org>/server-management-tool:latest
```

Open http://localhost:8080 and you're done.

### Option 2: Docker Compose

```yaml
# docker-compose.yml
services:
  smt:
    image: ghcr.io/<your-org>/server-management-tool:latest
    ports:
      - "8080:8080"
    volumes:
      - smt_data:/data
    restart: unless-stopped

volumes:
  smt_data:
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
2. Create your admin account.
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
  smt:
    image: ghcr.io/<your-org>/server-management-tool:latest
    environment:
      - SMT_BASE_URL=https://smt.yourcompany.com
      - SMT_ENCRYPTION_KEY=${SMT_ENCRYPTION_KEY} # generate once, keep secret
      - SMT_DB_URL=postgres://smt:smt@db:5432/smt # optional; SQLite by default
      - SMT_OAUTH_PROVIDER=google # optional SSO
    ports:
      - "8080:8080"
    volumes:
      - smt_data:/data
    depends_on: [db]
    restart: unless-stopped

  db:
    image: postgres:16
    environment:
      POSTGRES_USER: smt
      POSTGRES_PASSWORD: smt
      POSTGRES_DB: smt
    volumes:
      - smt_db:/var/lib/postgresql/data
    restart: unless-stopped

volumes:
  smt_data:
  smt_db:
```

Then put it behind your reverse proxy of choice (Caddy / Nginx / Traefik) with TLS, invite your team, and you're live.

**Storage backends:**

- **SQLite** (default) — zero-config, perfect for solo / small teams.
- **PostgreSQL** — recommended for teams of 5+ or HA setups.

**Authentication options:**

- Built-in email/password
- OAuth / SSO (Google, GitHub, GitLab, generic OIDC)
- Optional 2FA (TOTP)

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
- [ ] Server monitoring (CPU, memory, disk)
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
