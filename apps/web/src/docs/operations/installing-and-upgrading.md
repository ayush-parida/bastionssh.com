---
title: Installing & upgrading
section: operations
order: 10
summary: Run BastionSSH with Docker Compose, set the required environment variables, add HTTPS, and upgrade safely.
keywords: [install, docker, compose, upgrade, environment, env vars, https, caddy, reverse proxy, SMT_TRUST_PROXY, redis]
---

BastionSSH runs as one container (`smt`) that serves both the web app and the API on port 8080, with its data in a volume mounted at `/data`. The supported way to run it is the Docker Compose file in `deploy/docker/` of the repository, which also starts Redis and, optionally, Caddy for HTTPS.

## What gets stored where

| Thing | Location |
| --- | --- |
| Database (SQLite) | `/data/smt.db` |
| Database backups | `/data/backups` |
| Session recordings | `/data/recordings` |
| Cron job queue | Redis (`redis-data` volume) |

Everything sensitive in the database (SSH keys, passwords, tokens) is encrypted with `SMT_ENCRYPTION_KEY`. Keep that key safe and separate from your backups: without it, the stored credentials cannot be decrypted.

## Install with Docker Compose

1. Get the repository on the host and change into the compose folder:

   ```bash
   git clone https://github.com/ayush-parida/bastionssh.com.git
   cd bastionssh.com/deploy/docker
   ```

2. Create `deploy/docker/.env` with the two required secrets and your admin email:

   ```bash
   cat > .env <<EOF
   SMT_ENCRYPTION_KEY=$(openssl rand -base64 32)
   SMT_SESSION_SECRET=$(openssl rand -hex 32)
   SMT_ADMIN_EMAIL=you@example.com
   EOF
   chmod 600 .env
   ```

3. Start it:

   ```bash
   docker compose up -d
   ```

   Compose uses the image `ghcr.io/ayush-parida/bastionssh:latest`. If it cannot be pulled, `docker compose build` builds the same image from the repository.

4. Find the first owner's password. If you did not set `SMT_ADMIN_PASSWORD`, a random one is generated and printed once:

   ```bash
   docker compose logs smt | grep -A2 "Generated a random admin password"
   ```

5. Open `http://<host>:8080`, sign in with `SMT_ADMIN_EMAIL` and that password, and change the password under **Settings**. Then continue with [First steps](/docs/getting-started/first-steps).

> **Note:** The owner account is only created when the database has no users at all. Changing `SMT_ADMIN_EMAIL` or `SMT_ADMIN_PASSWORD` later has no effect.

> **Warning:** Leave `SMT_ADMIN_PASSWORD` unset or set a strong one. The development password `admin1234` is never accepted outside `NODE_ENV=development` or `test`; a random password is generated instead.

### Why Redis is included

Redis holds the queue that runs [cron jobs](/docs/servers/cron-jobs) on schedule. Without `SMT_REDIS_URL`, cron jobs can be saved and run by hand, but they are **not** run on their schedule (the server logs "set SMT_REDIS_URL to run cron jobs"). Health checks, cloud sync and backups do not need Redis.

## Add HTTPS with the bundled Caddy

The compose file has an opt-in `https` profile that puts Caddy in front of the app. Caddy gets and renews a certificate for your domain automatically.

1. Point your domain's DNS at the host and open ports 80 and 443.
2. Add to `deploy/docker/.env`:

   ```bash
   SMT_DOMAIN=bastion.example.com
   SMT_BASE_URL=https://bastion.example.com   # must be exactly https://$SMT_DOMAIN
   SMT_TRUST_PROXY=1                          # take client IPs from Caddy
   SMT_HTTP_BIND=127.0.0.1:8080               # keep plain HTTP off the network
   SMT_ACME_EMAIL=ops@example.com             # optional: certificate expiry notices
   ```

3. Start with the profile:

   ```bash
   docker compose --profile https up -d
   ```

Caddy refuses to start (see `docker compose logs caddy`) until all three rules hold: `SMT_BASE_URL` is `https://$SMT_DOMAIN`, `SMT_TRUST_PROXY` is set, and `SMT_HTTP_BIND` is a loopback address. Each protects something: passkeys are bound to the hostname, rate limits and the audit log need real client IPs, and nobody may reach the app directly and fake their address.

> **Warning:** Passkeys enrolled while you used `http://localhost:8080` will not work on the new domain. Enroll passkeys after switching to HTTPS.

### Using your own reverse proxy

Nginx, Traefik or your own Caddy work too. Make sure WebSockets (terminals) and server-sent events (AI chat) are passed through, set `SMT_BASE_URL` to the public `https://` URL, and set `SMT_TRUST_PROXY`:

| Value | Meaning |
| --- | --- |
| `false` (default) | Trust no proxy. Every user appears to come from the proxy's IP. |
| `1` (or another number) | Trust that many proxy hops. Usual for one reverse proxy. |
| `10.0.0.0/8,127.0.0.1` | Trust only these proxy addresses. |
| `true` | Trust every hop. Only when the app is unreachable except through the proxy. |

Without it, all users share one rate-limit bucket (100 requests a minute, 10 sign-ins a minute) and one IP in the audit log. The server logs a warning the first time it sees a forwarded request while this is unset.

## Environment variables

The compose file passes a fixed list of variables to the container. To set one that is not listed there (for example the monitoring thresholds), add it to the `environment:` section of the `smt` service, or to a `docker-compose.override.yml`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SMT_BASE_URL` | required (`http://localhost:8080` in compose) | Public URL. Used in links, the agent installer and passkeys |
| `SMT_ENCRYPTION_KEY` | required | Vault key, base64, at least 32 bytes |
| `SMT_SESSION_SECRET` | required | Signs sessions, at least 32 characters. Changing it invalidates every backup code |
| `SMT_PORT` / `SMT_HOST` | `8080` / `0.0.0.0` | Where the app listens inside the container |
| `SMT_DB_URL` | `/data/smt.db` | Path of the SQLite database file |
| `SMT_REDIS_URL` | unset (compose: `redis://redis:6379`) | Cron job queue |
| `SMT_LOG_LEVEL` | `info` | `trace` to `fatal` |
| `SMT_ADMIN_EMAIL` / `SMT_ADMIN_PASSWORD` | see above | First owner account |
| `SMT_TRUST_PROXY` | `false` | Which proxies' `X-Forwarded-For` to believe |
| `SMT_SMTP_URL` / `SMT_SMTP_FROM` | unset | Email for alerts and account notices |
| `SMT_WEBAUTHN_RP_ID` / `_RP_NAME` / `_ORIGINS` | from `SMT_BASE_URL` / `BastionSSH` | Passkey domain and allowed origins |
| `SMT_EGRESS_IP` / `SMT_EGRESS_IP_SERVICES` | looked up | The app's public IP shown by diagnostics; `off` to never look it up |
| `SMT_SFTP_MAX_UPLOAD_BYTES` | 1 GiB | Upload cap in the server file browser |
| `SMT_FTP_MAX_UPLOAD_BYTES` | 1 GiB | Upload cap for FTP/SFTP connections |
| `SMT_STORAGE_MAX_UPLOAD_BYTES` | 5 GiB | Upload cap for object storage |
| `SMT_DOCKER_IMAGE_UPLOAD_MAX_BYTES` | 5 GiB | Largest image archive for Docker → [Upload image](/docs/docker/upload-image) |
| `SMT_SFTP_OP_TIMEOUT_MS` | `30000` | Timeout of one SFTP operation on a file connection |
| `SMT_AI_REQUEST_TIMEOUT` | `60000` | AI provider request timeout (ms) |
| `SMT_MONITORING_*`, `SMT_ALERT_*` | see [Health monitoring](/docs/monitoring/health-monitoring) | Health checks and thresholds |
| `SMT_CLOUD_SYNC_*`, `SMT_CLOUD_REQUEST_TIMEOUT` | see [Cloud accounts](/docs/operations/cloud-accounts) | Cloud inventory sync |
| `SMT_BACKUP_*` | see [Backups & restore](/docs/operations/backups-and-restore) | Database backups |
| `SMT_RECORDINGS_DIR`, `SMT_RECORDING_MAX_BYTES` | `/data/recordings`, 50 MiB | Session recordings |
| `SMT_AUDIT_FORWARD_ALLOW_NETS` | unset | Private networks audit forwarding may reach |

The server checks these at start and exits with "Invalid environment variables" naming the problem, so a typo shows up immediately in `docker compose logs smt`.

## Upgrading

1. Check that a recent backup exists (**Settings → Database backups**) and that you have `SMT_ENCRYPTION_KEY` saved somewhere outside the host.
2. Pull the new image and recreate the containers:

   ```bash
   cd deploy/docker
   git pull                      # picks up compose file changes
   docker compose pull
   docker compose up -d          # add --profile https if you use it
   ```

3. Watch the start-up: `docker compose logs -f smt`.

When a new version needs to change the database, it first takes a **pre-migration backup** and refuses to migrate if that backup fails, so you can always go back. See [Backups & restore](/docs/operations/backups-and-restore) for rolling back.

> **Note:** If you upgrade from a version that trusted `X-Forwarded-For` from anyone, set `SMT_TRUST_PROXY` after upgrading, or every user will share the proxy's IP.
