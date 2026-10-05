# Server-side Deployments — Design

**Date:** 2026-10-05
**Status:** Approved in conversation — Docker-only, configuration and state live **on the server**, Caddy by default with an nginx mode, multiple sites per server. User: "proceed and use workflow or ultracode as per need".

## 1. Goal

Deploy web apps (Next.js first) to a managed server **without Git and without storing deployment information in BastionSSH**. The server is the single source of truth: config, secrets, releases and proxy config are files on the server; BastionSSH is only the interface (and keeps its audit log of who did what). A deploy works the same with or without BastionSSH (`ssh server bastionctl deploy site1`).

## 2. Decisions

1. **Docker-only runtime.** Each app runs as a container on a private Docker network `bastion-apps`; nothing but the proxy publishes ports.
2. **`bastionctl`** — a single-file Node program (bundled from `packages/bastionctl`, zero runtime deps) stored at `<root>/bin/bastionctl.mjs`, run through a small POSIX wrapper `<root>/bin/bastionctl` that executes it in a pinned `node:22-alpine` image (by digest) with `<root>` and the Docker socket mounted. It talks to the Docker Engine API over the socket and uses the image's busybox `tar`. No Node, YAML tool or CLI is needed on the host besides Docker.
3. **BastionSSH installs and verifies `bastionctl`**: it uploads the bundled file over SFTP and checks its SHA-256 against the version shipped with the app before every use; a mismatch is reported and the command refused ("Reinstall" action).
4. **Root directory:** `/opt/bastion` when writable (set up with `sudo` if the SSH user may), otherwise `$HOME/bastion`. Discovered on each use; never stored in BastionSSH.
5. **Proxy:** `proxy: caddy` (default) — one `bastion-caddy` container owning 80/443, automatic HTTPS. `proxy: nginx` — for servers that already run nginx: generated server blocks + certbot on the host via a host-side helper run with `sudo`.
6. **No deployment data in the BastionSSH database.** Only audit rows (who, server, app, action, release id, result). Uploads stream straight to the server.
7. **Permissions:** new **Deployments** module (built-ins: Admin manage, Operator operate, Viewer view; custom roles none) **and** server level: view → see apps/releases/status; operate → deploy, rollback, restart; manage → set up, edit `bastion.yml`/`.env`, delete an app. Migration `0026_deployments_module` adds the module to built-ins.

## 3. Layout on the server

```
<root>/
  bin/bastionctl, bin/bastionctl.mjs
  proxy/Caddyfile                 # generated; never hand-edited
  proxy/data/ proxy/config/       # Caddy certificates and state (volume)
  apps/<app>/
    bastion.yml                   # config (§4)
    .env                          # secrets, 0600; injected at run time
    releases/<id>/                # source.tar.gz, build.log, release.json
    current -> releases/<id>
    deploy.lock
```

`<app>` and release ids match `^[a-z0-9][a-z0-9-]{0,40}$`; release id = UTC timestamp + short source checksum.

## 4. `bastion.yml`

```yaml
name: site1
domains: [site1.com, www.site1.com]
redirect_www: apex            # apex | www | none
tls: auto                     # auto | staging | internal | dns:<provider> | { cert: path, key: path }
build:
  type: nextjs                # nextjs | dockerfile | static
  node: "20"                  # nextjs only; default from .nvmrc / engines / 20
  dir: .                      # project root inside the upload
  output: out                 # static only
run:
  port: 3000
  env_file: .env
  volumes: ["uploads:/app/public/uploads"]
  memory: 512m
  cpus: 1
healthcheck: { path: /, timeout: 30s }
keep_releases: 5
proxy: caddy                  # caddy | nginx
```

Strictly validated by `bastionctl validate` (unknown keys rejected, domain syntax, port range, no duplicate domain across apps on the server, path traversal in `dir`/`output`/volumes refused).

## 5. Deploy, rollback, operations

`bastionctl deploy <app> --source <file>`:
1. Acquire `deploy.lock` (exclusive create; stale after 30 min with dead pid/time).
2. Create `releases/<id>/`, extract the source (size cap, no absolute paths/`..`/symlinks escaping).
3. Build image `bastion-<app>:<id>` with labels `bastion.app`, `bastion.release`: **nextjs** → generated multi-stage Dockerfile (lockfile-detected package manager, `output: 'standalone'` required — a clear error explains how to enable it); **dockerfile** → project's Dockerfile; **static** → build then serve `output` with a minimal Caddy image. Build log written to `build.log` and streamed. One build per server at a time.
4. Start container `bastion-<app>-<id>` on `bastion-apps` with env file, volumes, limits, `restart: unless-stopped`.
5. Health check from inside the network (`docker exec bastion-caddy wget …`) until healthy or timeout → on failure stop and remove the new container, keep the old one serving, mark the release failed.
6. Regenerate the proxy config from all apps, validate, reload gracefully (Caddy admin API inside the container / `nginx -t` + reload). On failure restore the previous config. *(Phase B: Caddy proxies to a per-app alias `bastion-<app>-live-<port>` on an internal `bastion-live` network, which the new container joins after its health check; the config is reloaded only when its text changes, because even a graceful Caddy reload drops the odd just-accepted connection.)*
7. Point `current` at the new release, write `release.json` (who — passed by BastionSSH, when, checksum, image, result), stop and remove the old container after a drain delay.
8. Prune releases and images beyond `keep_releases` (never the current or previous).

Other commands: `init <app>` (scaffold from template or an uploaded `bastion.yml`), `list --json`, `status <app> --json` (container health, current release, domains, certificate issuer/expiry from Caddy), `releases <app> --json`, `rollback <app> <id>` (switch proxy to the kept image; no rebuild), `restart`, `stop`, `logs` (BastionSSH uses its Docker module for live logs), `env keys|set|unset` (values never printed except `env get` used by step-up reveal), `delete <app>` (stops, removes images, keeps or deletes data on request), `proxy apply`, `setup` (network, proxy container, directories), `version`.

## 6. Domains and TLS

- BastionSSH pre-checks each domain with the existing DNS lookup (A/AAAA must point to the server's public address) and, for `tls: auto`, that ports 80/443 are reachable (existing diagnostics). Problems are shown with the exact DNS record to create; the domain is still saved.
- Caddy obtains and renews certificates automatically; HTTP → HTTPS; `www` redirect per config; `staging` for testing; `internal` for private names; `dns:<provider>` for wildcards with the provider token in `<root>/proxy/.env` (never in BastionSSH); custom cert/key files in the app folder.
- Certificate status (issuer, expiry, last error) is read from the server and shown; renewal failures raise an alert through existing notification channels (alert state derived on read, not stored).
- **nginx mode:** existing nginx is detected (ports 80/443 owned by a host process). Generated server blocks go to `/etc/nginx/conf.d/bastion-<app>.conf` (only files with that prefix are touched), certificates via `certbot certonly --webroot`, renewal via certbot's own timer with a reload hook; requires passwordless `sudo` for the listed commands, shown during setup.

## 7. BastionSSH side

- **Server → Deployments tab:** Setup (installs `bastionctl`, creates the network and proxy, reports root dir and proxy mode, Docker/sudo prerequisites), app list (domains, health, current release, cert expiry, memory/CPU), per app: Deploy (upload zip/folder with progress; streamed to the server), live build/deploy log (SSE), Releases with Rollback, Restart/Stop, `bastion.yml` editor (form + raw YAML, validated by `bastionctl validate` before write), `.env` editor (keys listed; values write-only; reveal needs manage + passkey step-up and is audited), Domains with DNS/TLS status, Delete.
- All commands run over the existing SSH connection path (host keys, jump hosts, agents) through `execOnServer`-style helpers with streaming; upload via SFTP into a temp file under `<root>/tmp`.
- Nothing about apps is cached across requests; lists are read from the server each time (short in-request cache only).

## 8. Security

- `bastionctl` integrity check before each run; pinned base image digest; installed files 0755 and owned by the SSH user; `.env` 0600.
- Socket mount = root-equivalent (same as Docker management) — documented on the tab.
- All arguments passed to remote commands are validated identifiers and shell-quoted; config validated before use; uploads scanned for path traversal.
- Per-user stream caps, timeouts, and revocation (lost access closes deploy log streams).
- Audit: setup, deploy (start/result), rollback, restart/stop, config/env changes (keys only), env reveal, delete.

## 9. Testing

- `packages/bastionctl`: unit tests for config validation, Caddyfile and nginx generation, release naming/pruning, lock handling, tar safety, Dockerfile generation per package manager, against a fake Docker API.
- Server routes: permission matrix (module × server level), integrity-check refusal, streaming cancellation, audit rows, no deployment rows in the DB.
- Integration (env-gated, throwaway `docker:dind` + `openssh-server`): setup → deploy a tiny `dockerfile` app and a `static` app with `tls: internal` on two domains → both reachable through Caddy by Host header → second deploy zero-downtime → rollback → delete; failed health check keeps the old release serving. A Next.js deploy test runs when network access is available.
- Playwright against a stubbed API: Deployments tab, deploy flow with log, rollback, config editor validation errors.

## 10. Phases

| Phase | Scope |
| --- | --- |
| A | `bastionctl` core (config, release management, Docker API, Caddy generation, deploy/rollback/list/status/validate/setup), install + integrity check, migration 0026, server routes for setup/list/status/deploy/rollback with streaming |
| B | Build types (nextjs/dockerfile/static), zero-downtime switch, health checks, pruning, integration tests |
| C | Web: Deployments tab, deploy upload with live log, releases/rollback, config and env editors, domains with DNS/TLS status |
| D | nginx mode, DNS/port pre-checks, certificate status and alerts, docs |

## 11. Out of scope (later)

Building images on the BastionSSH host, pulling ready-made images from registries, `bastion deploy` laptop CLI, preview deployments, non-Docker runtimes, frameworks beyond nextjs/dockerfile/static.
