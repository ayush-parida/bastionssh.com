---
title: bastion.yml reference
section: deployments
order: 50
summary: Every field of an app's bastion.yml — type, default, what is accepted, and examples.
keywords: [bastion.yml, config, configuration, yaml, reference, fields, domains, tls, build, run, port, volumes, memory, cpus, healthcheck, keep_releases, proxy, permissions, redirect_www, image, strategy, recreate, publish, exclusive, tcp, command, service]
---

Each app has one `bastion.yml`, on the server at `<root>/apps/<app>/bastion.yml`. Edit it on the app's **Config** tab (a form, or the raw YAML; comments you write are kept), or with `bastionctl init <app> --config <file> --force` from a shell. A copy inside an upload is ignored.

## A complete example

```yaml
name: site1                         # the app's name
domains: [site1.com, www.site1.com]
redirect_www: apex                  # www.site1.com → site1.com
tls: auto                           # Let's Encrypt
build:
  type: nextjs                      # nextjs | dockerfile | static | image
  node: "20"
  dir: .
  where: server                     # server | bastion: build next to BastionSSH, ship only the image
  args: [SENTRY_RELEASE]            # .env names the build gets besides every NEXT_PUBLIC_*
run:
  port: 3000
  env_file: .env
  volumes: ["uploads:/app/public/uploads"]
  memory: 512m
  cpus: 1
healthcheck: { path: /, timeout: 30s }
keep_releases: 5
proxy: caddy
permissions: { deploy: operate }
```

The smallest valid config is a name, a domain and a build type:

```yaml
name: site1
domains: [site1.example.com]
build: { type: static, output: . }
```

A service — a database, a cache — pulled as a ready-made image, reached only by other apps on the server:

```yaml
name: orders-db
service: postgres                   # informational: the template it came from
domains: []                         # no web UI: no proxy entry
build:
  type: image
  image: postgres:16.4@sha256:…     # pulled, not built; the digest is recorded
run:
  port: 5432
  env_file: .env                    # POSTGRES_PASSWORD: bastionctl env generate orders-db POSTGRES_PASSWORD
  volumes: [{ name: data, path: /var/lib/postgresql/data, exclusive: true }]
  memory: 1g
  strategy: recreate                # stop the old container, then start the new one
  publish: none                     # none | localhost:<port> | public:<port>
healthcheck:
  type: command                     # http | tcp | command
  command: ["pg_isready", "-h", "127.0.0.1", "-U", "app"]
  timeout: 60s
keep_releases: 3
```

Other apps on the server reach it as `orders-db:5432` (for example `postgres://app:…@orders-db:5432/app`).

## How it is checked

The server validates the whole file before saving it, and again before each deploy, and reports **every** problem at once (the editor shows each next to its field):

- Unknown keys are refused at every level — a typo never silently does nothing.
- Duplicate keys, YAML anchors and aliases, and files over 64 KiB are refused.
- Paths (`build.dir`, `build.output`, `run.env_file`, certificate files) must be relative and stay inside the upload or the app folder: no leading `/`, no `..`.
- A domain another app on the server already uses is refused, and so is a host port another app publishes (`run.publish`).
- `proxy` must match how the server was set up (unless `domains` is empty: such an app never reaches the proxy).

A config saved while a deploy is running is the one that deploy goes live with: domains and TLS are read again at the moment traffic switches.

## name

| Type | Default | Accepted |
| --- | --- | --- |
| text | — (required) | `a-z`, `0-9` and `-`, starting with a letter or digit, at most 41 characters |

Must be the app's name — the folder it lives in. It is fixed once the app exists.

## service

| Type | Default | Accepted |
| --- | --- | --- |
| text | none | a template id: `a-z`, `0-9` and `-` (like `postgres`) |

The quick-service template an app was created from (see [Quick services](services-overview.md)). It changes nothing about how the container runs; it gives the app its service page in BastionSSH — the Connection panel, Update version — names the backup command bastionctl runs for [`backups`](#backups), and makes rollbacks keep the template's [version lines](releases-rollback.md#version-lines).

## domains

| Type | Default | Accepted |
| --- | --- | --- |
| list of text | — (required) | 0 to 50 domains, lower case |

`[]` is a service without a web UI (a database, a cache): it gets no proxy entry and no certificate, and only other apps on the server reach it, by its name on the `bastion-apps` network. The key itself is required, so a forgotten `domains` is an error rather than an app nobody can reach.

- Each domain has at least two labels (`example.com`, `app.example.com`), and the last is not all digits — IP addresses are not domains.
- A wildcard (`*.example.com`) is allowed only as the first label, and only with `tls: dns:<provider>`, `tls: internal` or certificate files.
- No domain twice, and none that another app on the server serves.

```yaml
domains: [example.com, www.example.com, shop.example.com]
```

See [Domains and HTTPS](domains-https.md) for the DNS records to create.

## redirect_www

| Type | Default | Accepted |
| --- | --- | --- |
| text | `none` | `apex`, `www`, `none` |

- `apex` — `www.example.com` redirects (301) to `example.com`.
- `www` — `example.com` redirects to `www.example.com`.
- `none` — every listed domain is served as it is.

A redirect happens only when **both** forms are in `domains`; the redirecting one still gets its own certificate.

## tls

| Type | Default | Accepted |
| --- | --- | --- |
| text or mapping | `auto` | `auto`, `staging`, `internal`, `dns:<provider>`, `{ cert: <file>, key: <file> }` |

- `auto` — certificates from Let's Encrypt, obtained and renewed automatically.
- `staging` — Let's Encrypt's staging CA: not trusted by browsers, for testing without hitting rate limits.
- `internal` — Caddy's own CA, for private names and intranets.
- `dns:<provider>` — the DNS challenge, needed for wildcards; `<provider>` is lower case letters, digits and `_` (e.g. `dns:cloudflare`).
- `{ cert: certs/cert.pem, key: certs/key.pem }` — your own certificate files, relative to the app folder.

With `proxy: nginx` only `auto` and `staging` are accepted. Details and caveats: [Domains and HTTPS](domains-https.md#tls-modes).

## build

### build.type

| Type | Default | Accepted |
| --- | --- | --- |
| text | — (required) | `nextjs`, `dockerfile`, `static`, `image` |

- `nextjs` — [built on the server from source](nextjs-dynamic.md), standalone output required.
- `dockerfile` — [your Dockerfile](dockerfile.md).
- `static` — [a folder of files](static-site.md), built with Node first when there is a `package.json`.
- `image` — a ready-made image from a registry ([`build.image`](#buildimage)): nothing is uploaded or built.

### build.image

| Type | Default | Accepted |
| --- | --- | --- |
| text | — (required with `type: image`) | `[registry[:port]/]repository[:tag][@sha256:<64 hex>]` with a tag or a digest, lower-case repository |

Only with `type: image`, and then `node`, `dir` and `output` are refused. **Deploy** (or `bastionctl deploy <app>`, without `--source`) pulls it on the server through the Docker API, tags it as the release's image (`bastion-<app>:<release>`) and records the digest it resolved to in the release (`digest` in `release.json`, shown under Releases). Rollback serves a kept release's image again without pulling.

- **Pin a digest** (`postgres:16.4@sha256:…`) to get the same bytes on every deploy; an image already on the server is then not pulled again. A tag alone (`postgres:16`) is pulled on every deploy, so a redeploy picks up what the tag points at now.
- Public registries only: there is no registry login.
- The image runs as the app's container like any other: `run.*`, `.env`, volumes and the health check apply. Its own `CMD` and `ENTRYPOINT` are used.

### build.node

| Type | Default | Accepted |
| --- | --- | --- |
| text (or number) | `.nvmrc`, `.node-version`, `engines.node`, else `20` | a version like `"20"` or `"22.11"`, major 18, 20, 22 or 24 |

Only for `nextjs` and `static`. Builds use the pinned image of the major version. Quote it (`"20"`) so YAML keeps `22.10` from becoming `22.1`.

### build.dir

| Type | Default | Accepted |
| --- | --- | --- |
| text | `.` | a relative folder inside the upload, without `..` |

Where the project (`package.json`, `Dockerfile`) is inside the upload. `apps/web` for a monorepo's app.

### build.output

| Type | Default | Accepted |
| --- | --- | --- |
| text | `out` | a relative folder inside `build.dir`, without `..`; `.` is `build.dir` itself |

Only for `static`: the folder that is served. With a `package.json`, the folder the build writes; without one, a folder of the upload.

### build.where

| Type | Default | Accepted |
| --- | --- | --- |
| text | `server` | `server`, `bastion` |

Where the image is built. `server`: the server installs dependencies and builds, next to the apps it serves. `bastion`: BastionSSH's builder builds it for the server's platform and ships only the image, so the server never runs `npm install` or the build — for small servers, or builds that need more memory than the server has. The Deploy dialog starts at this value and can change it for one deploy. Not with `type: image`. See [Build on BastionSSH](build-on-bastionssh.md).

### build.args

| Type | Default | Accepted |
| --- | --- | --- |
| list of text | `[]` | up to 64 `.env` variable names (`A-Z`, `a-z`, `0-9`, `_`, not starting with a digit) |

Names from the app's `.env` passed to the build as build arguments, besides every `NEXT_PUBLIC_*` (which builds always get). The values are read from `.env` when the build starts, masked in the build log and stored nowhere else. Generated Dockerfiles declare them with `ARG` in the build stage; your own Dockerfile must declare `ARG NAME` to use one. Whatever the build writes into its output ends up in the image, so pass only what the build needs. Not with `type: image`. See [Build-time values](build-on-bastionssh.md#build-time-values).

## run

### run.port

| Type | Default | Accepted |
| --- | --- | --- |
| number | `3000` | 1 to 65535 |

The port the app listens on inside its container. Ignored for `static` (always 80). Nothing is published on the host unless [`run.publish`](#runpublish) says so: the proxy and other apps on the server reach it on the private network.

### run.env_file

| Type | Default | Accepted |
| --- | --- | --- |
| text | `.env` | a file inside the app folder, without `..` |

The secrets file given to the container as its environment. See [Environment variables and secrets](environment.md).

### run.volumes

| Type | Default | Accepted |
| --- | --- | --- |
| list | none | `<name>:/absolute/path[:ro]`, or `{ name, path, readonly?, exclusive? }` |

Named Docker volumes for data that must survive deploys. `<name>` is lower case letters, digits, `_` and `-` (starting with a letter or digit, at most 41 characters), each name once; the path is absolute, not `/`, without `.` or `..` segments. Host paths are never accepted. The volume is called `bastion-<app>.<name>` on the server.

```yaml
run:
  volumes: ["uploads:/app/public/uploads", "data:/data"]
```

The long form takes the same name and path, plus:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `readonly` | true/false | `false` | Mounted read-only (as `:ro`). |
| `exclusive` | true/false | `false` | Only one container may use the volume at a time — a database's data directory. Forces [`run.strategy: recreate`](#runstrategy). |

```yaml
run:
  volumes: [{ name: data, path: /var/lib/postgresql/data, exclusive: true }]
```

Unknown fields are refused.

See [Volumes for persistent data](releases-rollback.md#volumes-for-persistent-data).

### run.memory

| Type | Default | Accepted |
| --- | --- | --- |
| text | no limit | a whole number (up to 6 digits) with `k`, `m` or `g` (`512m`, `1g`); at least `6m` |

The container's memory limit. When the app goes over it, it is killed and restarted.

### run.cpus

| Type | Default | Accepted |
| --- | --- | --- |
| number | no limit | 0.01 to 256 |

How many CPUs' worth of time the container may use (`0.5`, `1`, `2`).

### run.strategy

| Type | Default | Accepted |
| --- | --- | --- |
| text | `rolling` | `rolling`, `recreate` |

How a new release (or a restart) replaces the container that serves:

- `rolling` — the new container starts **next to** the old one and takes traffic once healthy; the old one stops after the drain. No downtime.
- `recreate` — the old container is **stopped first**, then the new one starts and is health-checked; once it is live the old one is removed. The app is unavailable for that time (a database restarting), but two containers never run on the same data at once. If the new container fails, it is removed and the old one is **started again**, and the deploy reports that it was.

`recreate` is required — and chosen without asking — when a volume is `exclusive` or a port is published (`run.publish`); `strategy: rolling` with either is refused.

### run.publish

| Type | Default | Accepted |
| --- | --- | --- |
| text | `none` | `none`, `localhost:<port>`, `public:<port>`, or either with `:<container port>` |

Exposes `run.port` on the server itself (or another port of the container, when a third part names it — `public:19000:9000` publishes MinIO's S3 port 9000 while its domain serves the console on `run.port` 9001):

- `none` — not published. The proxy and other apps on the server reach it as `<name>:<run.port>` on the private `bastion-apps` network. Use this whenever you can.
- `localhost:<port>` — bound on the server's `127.0.0.1:<port>`: reachable through an SSH tunnel (`ssh -L 5432:127.0.0.1:15432 …`), not from the network.
- `public:<port>` — bound on every address (`0.0.0.0:<port>`): reachable from anywhere the server's firewall allows. **Firewall it** to the addresses that need it; a database open to the internet is attacked within minutes.

The host port is 1 to 65535, not 80, 443 or the nginx-mode proxy port, and not one another app on the server publishes. Publishing forces `run.strategy: recreate` (one container can bind the port at a time).

### run.command

| Type | Default | Accepted |
| --- | --- | --- |
| list of text | the image's `CMD` | 1 to 64 arguments |

Replaces the image's command, as `command:` does in Compose — no shell unless you name one. Quick services use it for server flags; a value from `.env` is read inside the container with a shell:

```yaml
run:
  command: ["server", "/data", "--console-address", ":9001"]
  command: ["sh", "-c", "exec docker-entrypoint.sh redis-server --requirepass \"$REDIS_PASSWORD\""]
```

### run.entrypoint

| Type | Default | Accepted |
| --- | --- | --- |
| list of text | the image's `ENTRYPOINT` | 1 to 64 arguments |

Replaces the image's entrypoint; `run.command` is then its arguments. Rarely needed: the Mailpit template uses `["/bin/sh", "-c"]` to build its UI login from a generated password.

## healthcheck

| Field | Type | Default | Accepted |
| --- | --- | --- | --- |
| `type` | text | `http` with domains, `tcp` without | `http`, `tcp`, `command` |
| `path` | text | `/` | `http` only: starts with `/`, at most 200 characters, no spaces or quotes |
| `command` | list of text | — (required with `command`) | 1 to 64 arguments, none empty, no line breaks |
| `timeout` | text | `30s` | `ms`, `s` or `m` (`45s`, `2m`), from 1s to 10m |

After the new container starts, it is checked until it passes or `timeout` passes. Traffic switches only after it passes; otherwise the new container is removed and the previous release keeps serving (with `run.strategy: recreate`, the previous container is started again).

- `http` — the proxy container requests `path` from the app; any 2xx or 3xx answer passes.
- `tcp` — the proxy container opens a TCP connection to `run.port`; a connection that is accepted passes. The default for an app without domains.
- `command` — `command` runs **inside the new container** (as with `docker exec`, no shell unless you name one); exit code 0 passes. Without `type`, giving `command` implies it (and `path` implies `http`).

```yaml
healthcheck: { path: /api/health, timeout: 1m }
healthcheck: { type: tcp }
healthcheck: { type: command, command: ["pg_isready", "-h", "127.0.0.1", "-U", "app"], timeout: 60s }
healthcheck: { type: command, command: ["redis-cli", "ping"] }
```

> **Tip:** For PostgreSQL, check over TCP (`-h 127.0.0.1`): on first start the image runs a temporary server on its Unix socket only while it initialises, which a socket check would take for the real one.

## keep_releases

| Type | Default | Accepted |
| --- | --- | --- |
| number | `5` | a whole number from 2 to 50 |

How many releases (and their images) to keep for rollback. The current and previous release are always kept.

## proxy

| Type | Default | Accepted |
| --- | --- | --- |
| text | `caddy` | `caddy`, `nginx` |

Must match the server's proxy mode, chosen at setup. A new app's template already has the right one. See [Using nginx instead of Caddy](nginx.md).

## backups

| Field | Type | Default | Accepted |
| --- | --- | --- | --- |
| `schedule` | text | `off` | `off`, `hourly`, `daily` |
| `keep` | number | `7` | a whole number from 1 to 100 |

Backups of a quick service with a backup command (`service:` PostgreSQL, MySQL, MariaDB, MongoDB, Redis or Valkey). `keep` is how many backup files stay after each new one; `schedule` other than `off` has the server's `bastion-cron` container make one every hour or day. The service page's Backups tab edits this for you. See [Backups](services-overview.md#backups).

```yaml
backups: { schedule: daily, keep: 14 }
```

## permissions

| Field | Type | Default | Accepted |
| --- | --- | --- | --- |
| `deploy` | text | `operate` | `operate`, `manage` |

Who may deploy and roll back this app in BastionSSH: members with **operate** access to Deployments on the server (the default), or only those with **manage**. Restart and stop still need operate. See [Permissions](permissions.md#permissionsdeploy).

```yaml
permissions: { deploy: manage }
```
