---
title: Introduction
section: getting-started
order: 10
summary: What BastionSSH is, what it runs on, and a quick tour of every module in the sidebar.
keywords: [overview, introduction, modules, features, self-hosted, tour]
---

BastionSSH is a self-hosted, browser-based tool for running a fleet of Linux servers as a team. You install it once on a machine you control, add your servers and SSH keys, and from then on your team works in the browser: terminals, files, scheduled commands, containers, Kubernetes clusters, health checks and an audit trail of who did what.

Nothing is installed on the servers you manage. BastionSSH reaches them over SSH with the credentials you give it, and those credentials are encrypted at rest with a key only your instance holds (`SMT_ENCRYPTION_KEY`).

## Who it is for

- Small teams that share a handful (or a few hundred) servers and do not want to pass private keys around in chat.
- Operators who want one place to see whether servers are up, open a shell, and check what changed.
- Organisations that need roles, time-limited access and an audit log without running a full access-management platform.

## How it fits together

```text
Browser ──HTTPS/WebSocket──▶ BastionSSH (web app + API + worker) ──SSH──▶ your servers
                                     │
                                     └── SQLite database in the /data volume (encrypted credentials)
```

Everything — the web app, the API and the background worker — runs from one Docker image. Each instance belongs to the team that runs it; there is no central service and no telemetry. See [Installing & upgrading](/docs/operations/installing-and-upgrading) to set one up.

## A tour of the sidebar

What you see in the sidebar depends on your role: a module you have no access to is simply not shown. See [Concepts](/docs/getting-started/concepts) for how roles and modules work.

| Sidebar item | What it does |
| --- | --- |
| **Dashboard** | Things that need attention, fleet health at a glance and active cron jobs. |
| **Servers** | Your server inventory. Each server card has **Connect** (terminal), **Files** (SFTP), **Health**, **Docker**, **Deployments** and **Diagnose**. |
| **Containers** | Docker containers across every server you can reach, in one searchable list. |
| **Deployments** | Deploy web apps (Next.js, Dockerfile, static sites) to your own servers. See [Deployments](/docs/deployments/overview). |
| **Kubernetes** | Live cluster maps, app topology, plain-language diagnoses and guided fixes. |
| **Agents** | Small outbound agents that reach servers on private networks with no inbound SSH. |
| **Object Storage** | S3-compatible buckets (AWS S3, R2, MinIO, B2 and more): browse, upload, download. |
| **FTP** | FTP, FTPS and SFTP connections for hosts that only offer file access. |
| **Cloud Accounts** | Import instances from AWS, Google Cloud, Azure, DigitalOcean or Hetzner as servers. |
| **DNS Lookup** | Look up a domain's records and check propagation across public resolvers. |
| **Monitoring** | Agentless health checks (CPU, memory, disk, load) and alerts. |
| **SSH Keys** | Generate, import and rotate the keys BastionSSH logs in with. |
| **Saved Commands** | Reusable commands with `{{variables}}`, run on one server or many at once. |
| **Cron Jobs** | Schedules run by BastionSSH over SSH, with run history — nothing added to the server's crontab. |
| **AI Assistant** | Chat with your own AI provider; any command it wants to run waits for your approval. |
| **Audit Log** | Every sign-in, connection, command and change, with export and forwarding. |
| **Recordings** | Replays of terminal sessions and command runs. |
| **Team & Access** | Members, invites, roles, access requests, single sign-on and sign-in security. |
| **Settings** | Your own account (password, passkeys, sessions, API tokens) plus org-wide settings for those allowed to change them. |

## Security in one paragraph

SSH keys, server passwords and every other stored secret are encrypted with the instance's vault key and are never sent to the browser. SSH host keys are pinned so a changed server identity is refused rather than trusted. Sign-in supports passwords, passkeys and single sign-on (OpenID Connect), and every meaningful action lands in the audit log. Terminal sessions can be recorded for replay.

> **Note:** BastionSSH is not a replacement for configuration management (Ansible, Puppet) or a full observability stack. It is the place your team connects from, checks on things, and fixes them.

## Where to next

1. [First steps](/docs/getting-started/first-steps) — sign in, add a key and a server, and open your first terminal.
2. [Concepts](/docs/getting-started/concepts) — servers, roles, modules and the audit log in plain words.
3. [Adding servers](/docs/servers/adding-servers) — every option in the server form, including jump hosts and agents.
