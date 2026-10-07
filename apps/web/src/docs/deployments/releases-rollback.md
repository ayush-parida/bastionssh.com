---
title: Releases, rollback and server sizing
section: deployments
order: 80
summary: How releases are kept, rolling back without a rebuild, zero-downtime switches, volumes for data that must survive deploys, and how big a server you need.
keywords: [release, releases, rollback, roll back, version line, force-line, line_change_refused, zero downtime, downtime, keep_releases, volumes, persistent, data, backup, memory, cpu, limits, sizing, disk, swap, server size]
---

## Releases

Every deploy makes a **release**, named by its UTC time and a short checksum of the upload (`20261005-120000-abcdef12`). It lives in `<root>/apps/<app>/releases/<id>/`:

- `source.tar.gz` (or `source.tar`) — the upload, as it arrived.
- `build.log` — the build's output, with `.env` values masked.
- `release.json` — who deployed it, when, the image, the result and any error.

`current` points at the release being served. The **Releases** tab lists them newest first, with who deployed each one, its result, and whether its image is still there.

After a successful deploy, releases beyond `keep_releases` (default 5) are deleted with their images — never the current or the previous one.

## Rollback

**Roll back** on the Releases tab serves a kept release again. Nothing is rebuilt: its image starts as a new container with today's `.env` and volumes, passes the health check, and takes over the traffic just as a deploy does.

- Only a release that deployed successfully, and whose image is still kept, can be rolled back to.
- Rollback follows the same permission as deploy (see [Permissions](permissions.md)).
- The config used is today's `bastion.yml` (domains, port, limits), not the one of that time.

### Version lines

A [quick service](services-overview.md) keeps **Update version**'s rules when it rolls back, so a rollback is never a way around them:

- A template that stays within its line — the databases (PostgreSQL, MySQL, MariaDB, MongoDB, ClickHouse), Redis and Valkey, RabbitMQ, Meilisearch, Uptime Kuma — cannot be rolled back to a release on **another line**, older or newer: the data files of one major are not the other's. Rolling back within the line (PostgreSQL 17.11 → 17.4) works as for any app.
- A template whose data carries over (Grafana, SeaweedFS, MinIO, Mailpit) may roll back to a **newer** line but not to an **older** one: Grafana 13 migrated its database, and Grafana 12 cannot read it.

The Releases tab disables **Roll back** on such a release and says why when you point at it; the API answers `409 line_change_refused` with the reason, and bastionctl refuses the same rollback from a shell. Each release records its line in `release.json` when it is deployed (`ref`, `service`, `line`). For a release deployed before that, the line is read from the image its build log names, checked against the release's checksum; if it still cannot be told, the rollback is refused too.

When you know better — a release that only *looks* like another line — a manager can roll back anyway: `bastionctl rollback <app> <release> --force-line` on the server, or `forceLine: true` in the API's rollback request (manage on Deployments and the server; recorded in the audit log). Refused attempts are recorded as `deploy.rollback` with `result: refused`. Apps without `service:` in their `bastion.yml` have no lines and are not affected.

## Restart

**Restart** on an app's page starts a fresh container of the **current** release the same way: today's `.env`, volumes, limits and domains, a health check, then the switch, then the old container stops. Use it to apply a `.env` or config change without uploading again. If the new container is unhealthy, the old one keeps serving and the restart reports the failure. `NEXT_PUBLIC_*` values are baked into the build, so they still need a deploy.

## Zero downtime

A deploy or rollback never stops the site:

1. The new container starts next to the running one, out of the proxy's rotation.
2. The proxy container requests the health-check path from it until it succeeds (or `healthcheck.timeout` passes — then the new container is removed and nothing changes).
3. The new container joins the app's live address, so both serve for a moment. The proxy's configuration is not even reloaded unless something in it changed (the first deploy, another port, domains or TLS).
4. After a drain of about 10 seconds, the old container is stopped (it gets time to finish what it is doing) and removed. A `GET` it drops is retried on the new one.

When the proxy configuration does change — an app added, domains or TLS edited — a second proxy starts with the new configuration, takes new connections once it serves every certificate the old one did, and the old one finishes its connections. No request is dropped (an idle kept-alive connection may be closed, which browsers retry on their own).

Two deploys of the same app cannot overlap: the second is refused while the first holds the app's lock. Builds of different apps on one server run one at a time; a second waits its turn.

## Volumes for persistent data

A container is replaced on every deploy, and what it wrote inside itself goes with it. Data that must stay — uploaded files, a SQLite database — goes in a named volume:

```yaml
run:
  volumes: ["uploads:/app/public/uploads", "db:/data"]
```

- The volume is created on first use as `bastion-<app>.<name>` and kept across deploys and rollbacks.
- Host paths are not accepted — only named volumes.
- `:ro` mounts it read-only.
- Deleting an app keeps its volumes unless you tick **Also delete its bastion.yml, .env and volumes**.

> **Tip:** The image `build.type: nextjs` generates runs as a non-root user. Commit the folder you mount over (for example `public/uploads/.gitkeep`) so it exists in the image with that user as owner — a new volume copies the folder's ownership from the image.

Back up a volume from the server's shell:

```sh
docker run --rm -v bastion-site1.uploads:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/site1-uploads.tar.gz -C /data .
```

## Resource limits and server sizing

Set limits so one app cannot starve the others:

```yaml
run:
  memory: 512m
  cpus: 1
```

The app list shows each app's memory and CPU use, and the app's page has live charts when you may inspect containers through the Docker module.

What things use:

- **Builds run on the server.** A Next.js build wants about 1–2 GB of memory on its own; on a 1 GB server add 2 GB of swap or builds may be killed. Only one build runs at a time, so builds do not add up. Static and Dockerfile builds depend on the project.
- **Running apps:** the proxy uses a few tens of MB; a Next.js standalone server typically 100–300 MB; a static site a few MB.
- **Disk:** each kept release keeps its image — often 150–500 MB for Node.js apps, with layers shared between releases of an app. `keep_releases: 5` with a few apps fits comfortably in 20 GB; lower it on small disks.

Rules of thumb:

| Server | Fits |
| --- | --- |
| 1 vCPU, 1 GB (+ 2 GB swap) | a few static sites or small Dockerfile apps; one small Next.js app, ideally built elsewhere ([option 2](nextjs-dynamic.md#option-2-build-yourself-upload-only-the-build)) |
| 2 vCPU, 2 GB | 2–3 Next.js apps built on the server, plus static sites |
| 2 vCPU, 4 GB, 40 GB disk | **4–5 sites** comfortably: e.g. four Next.js apps at `memory: 512m` each plus static sites, with room for a build |
| 4 vCPU, 8 GB | many sites, or heavier apps with their own workers |

Builds slow down the sites on the same server while they run; if that matters, build elsewhere or deploy outside busy hours.
