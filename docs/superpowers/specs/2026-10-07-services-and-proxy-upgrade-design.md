# Quick Services and Automatic Proxy Upgrades — Design

**Date:** 2026-10-07
**Status:** Approved in conversation ("make the reinstall update the proxy automatically too, also i want quick deploy of common services like mongo, postgres, redis, minio and others"). Kubernetes targets are out of scope.

## 1. Goals

1. **Proxy upgrades without a manual Reinstall.** When a server's proxy (the proxy front and `bastion-caddy`) comes from an older bastionctl, it is replaced automatically, the same way bastionctl itself now is.
2. **Quick services.** One-click deployment of common backing services (databases, caches, object storage, queues, a few admin tools) onto a managed server, using the existing server-side deployment model: config and secrets live on the server under `<root>/apps/<name>/`; BastionSSH stores nothing but audit rows.

## 2. Automatic proxy upgrade

- bastionctl labels the proxy containers with the build id (`bastion.build`) and can tell "outdated" from "missing" or "broken".
- **When:** at the start of any command that already changes traffic — deploy, rollback, restart, proxy apply, setup/Reinstall — never on read-only requests. Also a **"Update proxy now"** button (operate) and the state API reports `proxyOutdated`.
- **How:** Caddy is replaced behind the proxy front with no dropped connections (the front holds the listening sockets). If the **front itself** changed, it is replaced too, which can drop in-flight connections for about a second; the log says so. The previous proxy containers are kept until the new ones answer a health check, and restored on failure.
- Pinned servers (`<root>/bin/.pinned`) are not upgraded automatically.
- Audited as `deploy.proxy_upgrade` (from/to build, trigger, result).
- Reinstall continues to update everything; it no longer needs to be clicked after BastionSSH updates.

## 3. Quick services

### 3.1 Catalog (code in BastionSSH, versioned, reviewed)

| Service | Image (official) | Kind | Default port | Web UI via domain |
| --- | --- | --- | --- | --- |
| PostgreSQL | `postgres` | database | 5432 | — |
| MySQL | `mysql` | database | 3306 | — |
| MariaDB | `mariadb` | database | 3306 | — |
| MongoDB | `mongo` | database | 27017 | — |
| Redis | `redis` | cache | 6379 | — |
| Valkey | `valkey/valkey` | cache | 6379 | — |
| Memcached | `memcached` | cache | 11211 | — |
| MinIO | `minio/minio` | object storage | 9000 (S3) | console 9001 |
| RabbitMQ | `rabbitmq:*-management` | queue | 5672 | management 15672 |
| Meilisearch | `getmeili/meilisearch` | search | 7700 | yes |
| ClickHouse | `clickhouse/clickhouse-server` | analytics DB | 8123 / 9000 | — |
| Mailpit | `axllent/mailpit` | dev mail | 1025 SMTP | UI 8025 |
| Adminer | `adminer` | admin UI | 8080 | yes |
| Grafana | `grafana/grafana` | dashboards | 3000 | yes |
| Uptime Kuma | `louislam/uptime-kuma` | monitoring | 3001 | yes |

Each template defines: offered versions (major lines, each pinned by digest at release of BastionSSH), environment with generated secrets, data volumes and their mount paths, health check (command or TCP), resource defaults, ports (internal, optional publish, HTTP UI port), connection-string formats, backup/restore commands where supported, and upgrade rules.

### 3.2 Config: new `build.type: image`

```yaml
name: orders-db
service: postgres            # template id (informational; drives the UI)
build:
  type: image
  image: postgres:16.4@sha256:…
run:
  port: 5432
  env_file: .env
  volumes: ["data:/var/lib/postgresql/data"]
  memory: 1g
  strategy: recreate         # stop old, then start new (required with exclusive volumes)
  publish: none              # none | localhost:<port> | public:<port>
healthcheck:
  type: command              # http | tcp | command
  command: ["pg_isready", "-U", "app"]
  timeout: 60s
domains: []                  # only for services with a web UI
keep_releases: 3
```

- `build.type: image` pulls the image (digest-pinned) instead of building; the release records the digest.
- `healthcheck.type` gains `tcp` and `command` (run inside the container).
- `run.strategy: recreate` stops the old container before starting the new one (brief downtime). It is **forced** for templates with exclusive data volumes; `rolling` (today's behaviour) remains the default for apps.
- `run.publish` exposes the port on the host: `none` (default — reachable only from other apps on the private network as `<name>:<port>`), `localhost:<port>` (SSH tunnels), or `public:<port>` (with a clear warning, a reminder to firewall it, and the diagnostics port check).

### 3.3 Deploying a service

**Deployments → New service** → pick a template → name, version, memory, publish option, optional domain for the web UI → Create.
- Credentials are generated (strong random) and written to the server's `.env`; never stored in BastionSSH.
- The service page shows **Connection**: internal host (`<name>`), port, user, database, and connection strings for apps on the same server (`postgres://app:••••@orders-db:5432/app`) and, if published, for outside use. Revealing the password uses the existing passkey step-up and is audited.
- Restart, Stop, Logs, Releases work as for apps. **Update version** changes the image within the same major line; a major-version change for databases is refused with an explanation (dump and restore needed) unless the template supports in-place upgrades.

### 3.4 Backups (databases)

- **Back up now** runs the template's dump command inside the container (`pg_dump -Fc`, `mysqldump`, `mongodump --archive`, `redis-cli --rdb`) into `<root>/apps/<name>/backups/<timestamp>.<ext>` with retention (`backups.keep`, default 7) and an optional schedule (`backups.schedule: daily|hourly|off`, run by bastionctl via a timer container or cron entry chosen at implementation).
- **Download** a backup (manage + passkey step-up, streamed, audited). **Restore** from a listed backup (manage, confirmation naming the service; stops dependents? no — documented).

### 3.5 Security

- Images only from the catalog's pinned digests; no arbitrary image in the quick-service flow (arbitrary images remain possible via `build.type: image` in raw `bastion.yml` for managers).
- Secrets generated server-side by bastionctl (crypto random), never sent to BastionSSH except through reveal.
- Published ports default off; `public` requires manage and shows a warning.
- Permissions: Deployments module + server level (view: see; operate: restart/stop/backup now; manage: create, update version, publish, reveal, download, restore, delete).

## 4. Docs

In-app docs section **Deployments → Services**: overview, one page per service (connection examples for Node.js/Next.js, Python, Go), backups and restore, upgrading, exposing a service, troubleshooting. Proxy upgrade documented in the overview.

## 5. Testing

- bastionctl: config validation (image/strategy/publish/healthcheck types), recreate strategy never overlaps containers on a volume, secret generation, backup/retention, proxy upgrade (caddy-only zero-drop, front replacement, restore on failure).
- Server routes: catalog, create-from-template, connection info/reveal, backups list/download/restore, permissions matrix, audit.
- Live (throwaway docker:dind + openssh-server): deploy PostgreSQL, Redis, MongoDB and MinIO from templates; an app container on the same network connects to each; back up and restore PostgreSQL; update Redis minor version (recreate); proxy upgrade from an older build with continuous requests.
- Playwright: catalog, create service dialog, connection panel, backups.

## 6. Out of scope

Kubernetes targets, clustered/replicated databases, managed TLS for database protocols, point-in-time recovery.
