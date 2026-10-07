---
title: Quick services
section: deployments
order: 130
summary: Start PostgreSQL, MySQL, MongoDB, Redis, SeaweedFS and other services on a server in one step — how they are created, how apps connect, exposing them, backups and restore, upgrading, and permissions.
keywords: [services, database, catalog, new service, postgres, mysql, mongodb, redis, seaweedfs, s3, minio, backups, restore, bastion-cron, publish, connection, update version]
---

**Deployments → New service** starts a database, cache, object store, queue or admin tool on the server from a catalog of templates. A service is an app like any other on the Deployments tab — its config, secrets and data live on the server, in `apps/<name>/` — with a page made for it: connection details, backups and Update version.

## The catalog

| Service | Versions | Kind | Port | Web UI | Backups | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| PostgreSQL | 18, 17, 16 | database | 5432 | — | `pg_dump -Fc` | [PostgreSQL](services-postgres.md) |
| MySQL | 8.4 LTS, 9 | database | 3306 | — | `mysqldump` | [MySQL and MariaDB](services-mysql.md) |
| MariaDB | 11.8 LTS, 11.4 LTS | database | 3306 | — | `mariadb-dump` | [MySQL and MariaDB](services-mysql.md) |
| MongoDB | 8.0, 7.0 | database | 27017 | — | `mongodump --archive` | [MongoDB](services-mongodb.md) |
| Redis | 8, 7.4 | cache | 6379 | — | RDB snapshot | [Redis and Valkey](services-redis.md) |
| Valkey | 9, 8 | cache | 6379 | — | RDB snapshot | [Redis and Valkey](services-redis.md) |
| Memcached | 1.6 | cache | 11211 | — | — | [Other services](services-others.md#memcached) |
| SeaweedFS (recommended) | 4 | object storage | 8333 (S3) | — (S3 API on a domain) | — | [SeaweedFS](services-seaweedfs.md) |
| MinIO | community build | object storage | 9000 (S3) | console | — | [MinIO](services-minio.md) |
| RabbitMQ | 4 (management) | queue | 5672 | management UI | — | [RabbitMQ](services-rabbitmq.md) |
| Meilisearch | 1.52 | search | 7700 | HTTP API | — | [Other services](services-others.md#meilisearch) |
| ClickHouse | 25.8 LTS, 26.3 LTS | analytics | 8123, 9000 | — | — | [Other services](services-others.md#clickhouse) |
| Mailpit | 1 | dev mail | 1025 (SMTP) | web UI | — | [Other services](services-others.md#mailpit) |
| Adminer | 5 | admin UI | 8080 | web UI | — | [Other services](services-others.md#adminer) |
| Grafana | 13, 12 | dashboards | 3000 | web UI | — | [Other services](services-others.md#grafana) |
| Uptime Kuma | 2 | monitoring | 3001 | web UI | — | [Other services](services-others.md#uptime-kuma) |

For object storage, pick **SeaweedFS**: it runs from the project's own image and is marked *Recommended* in the catalog. MinIO stays available with a *Community image* badge — MinIO no longer publishes images, so it runs a community build.

Every image is pinned by **digest** in BastionSSH's catalog — the exact bytes the catalog was reviewed with, on every server, whatever the registry's tags say later. A new BastionSSH release brings newer pins; a service moves to one when you click **Update version**.

## Creating a service

1. Open the server's **Deployments** tab and click **New service** (you need **manage** access to Deployments on the server).
2. Pick a template — search, or filter by category.
3. Fill in the form:
   - **Name** — how other apps on the server reach it (`orders-db`). Lower case, digits and `-`.
   - **Version** — the line (PostgreSQL 17); the exact release and image are shown under it.
   - **Memory limit** — the container's limit; the template's default fits a small app.
   - **Reachable from** — apps on this server only (the default), this server's localhost, or the internet. See [Exposing a service](#exposing-a-service).
   - **Domain** — only for services with a web UI (MinIO's console, Grafana, Adminer…): served through the proxy with HTTPS.
4. Click **Create**. The log shows what happens on the server:
   - its `bastion.yml` is written from the template — the pinned image, the health check, the volumes, `run.strategy: recreate` for data that only one container may use at a time;
   - its fixed settings (user and database names) are written to its `.env`;
   - every password and key is **generated on the server** (`bastionctl env generate`) — BastionSSH never sees them unless someone reveals one;
   - the image is pulled and the container started and health-checked, like any deploy.

If the deploy fails (a pull refused by the registry, a health check timing out), the service stays created: fix the cause and click **Deploy** on its page. Creating a service is recorded in the audit log as `deploy.service_create`, with its template, version and options — never a secret.

The `bastion.yml` it writes is an ordinary one; for PostgreSQL 17:

```yaml
name: orders-db
service: postgres
domains: []
build:
  type: image
  image: "postgres:17.11-alpine@sha256:…"
run:
  port: 5432
  env_file: .env
  memory: 512m
  strategy: recreate
  publish: "none"
  volumes:
    - { name: data, path: "/var/lib/postgresql/data", exclusive: true }
healthcheck:
  type: command
  command: [ "sh", "-c", "pg_isready -h 127.0.0.1 -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\"" ]
  timeout: 120s
backups: { schedule: "off", keep: 7 }
keep_releases: 3
proxy: caddy
```

## Connecting from your apps

Every app container on the server is on the private `bastion-apps` Docker network, where each app answers to **its name**. An app connects to the service at `<name>:<port>` — `orders-db:5432` — with no port published anywhere.

The service page's **Connection** panel lists the host, port, user and database, and ready connection strings, with the password masked:

```
postgres://app:••••••••@orders-db:5432/app
```

**Reveal password** asks for your passkey (manage access; recorded as `deploy.env_reveal`) and fills it in, ready to copy. Put the string into your app's **Environment** (`DATABASE_URL`, say) and restart the app — the value never has to leave the server's two `.env` files and your clipboard.

> **Tip:** Each service page links to its own guide with examples for Node.js (including Next.js and Prisma), Python and Go.

## Exposing a service

By default a service is reachable **only** from apps on the same server. To reach it from elsewhere, pick another option when you create it (or set [`run.publish`](bastion-yml.md#runpublish) in its config and restart):

- **This server's localhost** (`publish: localhost:15432`) — bound on the server's `127.0.0.1` only. From your machine, open an SSH tunnel and connect to your own localhost:

  ```bash
  ssh -N -L 15432:127.0.0.1:15432 deploy@your-server
  psql "postgres://app:<password>@127.0.0.1:15432/app"
  ```

  This is the safe way to use a desktop client (TablePlus, DBeaver, Compass) against a server's database.
- **The internet** (`publish: public:15432`) — bound on every address. Anything that can reach the port can try passwords. Allow only your own addresses in the server's firewall, for example with ufw:

  ```bash
  sudo ufw allow from 203.0.113.7 to any port 15432 proto tcp
  ```

  Docker publishes ports past ufw's own rules on many systems (it writes its own iptables rules): check from another network that only your addresses get through, for example with `nc -zv your-server 15432`. A cloud firewall (security group) in front of the server is the dependable place for the rule.

A service with a web UI is better given a **domain**: the proxy serves it with HTTPS, and nothing but ports 80 and 443 is open. Memcached has no authentication at all — keep it unpublished.

## Backups

PostgreSQL, MySQL, MariaDB, MongoDB, Redis and Valkey have a **Backups** tab:

- **Back up now** runs the template's dump command **inside the service's container** (`pg_dump -Fc`, `mysqldump --single-transaction`, `mongodump --archive --gzip`, a Redis RDB snapshot) and streams it straight into a file on the server: `apps/<name>/backups/<UTC time>.<ext>`, readable only by the deployments user. Nothing passes through BastionSSH.
- **Keep** (default 7) — after each backup the oldest manual and scheduled files beyond it are removed (pre-restore backups are kept).
- **Schedule** — every hour or every day. Schedules run on the server, in a small container named `bastion-cron` that bastionctl creates while at least one service has a schedule: every minute it runs `bastionctl backups run-due`, which backs up each service whose newest backup is an hour (or a day) old. It needs nothing on the server but Docker — no cron daemon, no crontab — survives reboots, and always runs the bastionctl BastionSSH last installed. A scheduled backup that fails is shown on the Backups tab and tried again a quarter of an hour later.
- **Download** a backup (manage; asks for your passkey, like a reveal; recorded as `deploy.backup_download`).

A backup and a deploy of the same service never run at once: each takes the service's lock, and the other waits for the next minute (a schedule) or reports the lock (a click).

> **Warning:** Backups live on the same server as the data. Download them, or copy `apps/<name>/backups/` to another machine or to object storage, regularly — a lost disk loses both.

## Restoring a backup

**Restore** (manage) asks you to type the service's name. Then, on the server:

1. The data as it is now is backed up first, to `<time>-pre-restore.<ext>` — undoing a restore is restoring that file. Retention (`keep`) never removes these; delete them by hand once you no longer need them.
2. The backup is put back **into the running service**: copied into the container and read by `pg_restore --clean --single-transaction`, `mysql`, or `mongorestore --drop`. For Redis and Valkey the container is stopped, its `dump.rdb` replaced, and started again (a few seconds without the cache).

Apps using the service are **not stopped**: they keep their connections and may see errors, missing rows or a short outage while it restores. If they must not write in the meantime, stop them first (their **Stop** button) and restart them afterwards. Restores are recorded as `deploy.backup_restore`.

To restore a backup into **another** service — a copy for testing, or a new major version — copy the file into that service's folder on the server, then restore it there:

```bash
cp /opt/bastion/apps/orders-db/backups/20261007T030000Z.dump /opt/bastion/apps/orders-db-18/backups/
```

## Upgrading

**Update version** moves a service to the release the catalog pins for its line — PostgreSQL 17.4 to 17.11 — by rewriting `build.image` and deploying it: the container stops, the new one starts on the same data volume and is health-checked; if it fails, the previous one starts again and `bastion.yml` names the previous image again. A dot on the button means the catalog has a newer release of the line.

Moving a **database** to another major version is refused: the data files of PostgreSQL 16 are not PostgreSQL 17's, and MongoDB, MySQL and MariaDB need their own upgrade steps. Move with a dump and a restore instead:

1. **Back up now** on the old service.
2. Create a new service of the new version (`orders-db-17`).
3. Copy the backup into the new service's `backups/` folder (above) and **Restore** it there.
4. Point your apps at the new name, check them, and delete the old service.

Templates whose data carries over (Grafana, SeaweedFS, MinIO, Mailpit) may change line in place, forward only; their Update version dialog says so.

The same rules hold for **Roll back** on the Releases tab: a release on another major line of a database, or on an older line of a forward-only template (Grafana 13 → 12), cannot be rolled back to — its button is disabled and says why. See [Version lines](releases-rollback.md#version-lines).

## Permissions

| Action | Level on Deployments and the server |
| --- | --- |
| See services, connection details (passwords masked), backups | view |
| Restart, stop, back up now | operate |
| Create, Update version, reveal passwords, download, restore, delete backups, change the schedule, delete the service | manage |

## Troubleshooting

- **The health check fails on first start** — a database initialises its data folder before it listens, which can take a minute on a slow disk. The templates wait up to two or three minutes; raise `healthcheck.timeout` in the Config tab for a very slow server.
- **The container keeps restarting** — usually the memory limit: check the Live log on its Overview; raise the limit in Config (`run.memory`) and restart.
- **`Host port … is already published by app …`** — another app publishes that host port; pick another one.
- **`toomanyrequests` while pulling** — Docker Hub limits anonymous pulls per address. Wait, or log the server's Docker in to Docker Hub (`docker login`).
- **A backup reports the lock** — a deploy, restore or another backup of the service is running; try again when it finishes.
- **Scheduled backups never run** — the Backups tab shows `bastion-cron`'s state; **Reinstall** on the Deployments tab sets it up again, and `docker logs bastion-cron` on the server shows each run.

## From a shell

Everything above is a `bastionctl` command on the server (see [Deploying without BastionSSH](without-bastionssh.md)):

```bash
bastionctl backup orders-db --keep 14
bastionctl backups list orders-db
bastionctl backups schedule orders-db daily --keep 14
bastionctl restore orders-db 20261007T030000Z.dump
bastionctl set-image orders-db "postgres:17.11-alpine@sha256:…" && bastionctl deploy orders-db
```
