---
title: bastion.yml reference
section: deployments
order: 50
summary: Every field of an app's bastion.yml — type, default, what is accepted, and examples.
keywords: [bastion.yml, config, configuration, yaml, reference, fields, domains, tls, build, run, port, volumes, memory, cpus, healthcheck, keep_releases, proxy, permissions, redirect_www]
---

Each app has one `bastion.yml`, on the server at `<root>/apps/<app>/bastion.yml`. Edit it on the app's **Config** tab (a form, or the raw YAML; comments you write are kept), or with `bastionctl init <app> --config <file> --force` from a shell. A copy inside an upload is ignored.

## A complete example

```yaml
name: site1                         # the app's name
domains: [site1.com, www.site1.com]
redirect_www: apex                  # www.site1.com → site1.com
tls: auto                           # Let's Encrypt
build:
  type: nextjs                      # nextjs | dockerfile | static
  node: "20"
  dir: .
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

## How it is checked

The server validates the whole file before saving it, and again before each deploy, and reports **every** problem at once (the editor shows each next to its field):

- Unknown keys are refused at every level — a typo never silently does nothing.
- Duplicate keys, YAML anchors and aliases, and files over 64 KiB are refused.
- Paths (`build.dir`, `build.output`, `run.env_file`, certificate files) must be relative and stay inside the upload or the app folder: no leading `/`, no `..`.
- A domain another app on the server already uses is refused.
- `proxy` must match how the server was set up.

A config saved while a deploy is running is the one that deploy goes live with: domains and TLS are read again at the moment traffic switches.

## name

| Type | Default | Accepted |
| --- | --- | --- |
| text | — (required) | `a-z`, `0-9` and `-`, starting with a letter or digit, at most 41 characters |

Must be the app's name — the folder it lives in. It is fixed once the app exists.

## domains

| Type | Default | Accepted |
| --- | --- | --- |
| list of text | — (required) | 1 to 50 domains, lower case |

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
| text | — (required) | `nextjs`, `dockerfile`, `static` |

- `nextjs` — [built on the server from source](nextjs-dynamic.md), standalone output required.
- `dockerfile` — [your Dockerfile](dockerfile.md).
- `static` — [a folder of files](static-site.md), built with Node first when there is a `package.json`.

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

## run

### run.port

| Type | Default | Accepted |
| --- | --- | --- |
| number | `3000` | 1 to 65535 |

The port the app listens on inside its container. Ignored for `static` (always 80). Nothing is published on the host: only the proxy reaches it.

### run.env_file

| Type | Default | Accepted |
| --- | --- | --- |
| text | `.env` | a file inside the app folder, without `..` |

The secrets file given to the container as its environment. See [Environment variables and secrets](environment.md).

### run.volumes

| Type | Default | Accepted |
| --- | --- | --- |
| list of text | none | `<name>:/absolute/path` or `<name>:/absolute/path:ro` |

Named Docker volumes for data that must survive deploys. `<name>` is lower case letters, digits, `_` and `-` (starting with a letter or digit, at most 41 characters), each name once; the path is absolute, not `/`, without `.` or `..` segments. Host paths are never accepted. The volume is called `bastion-<app>.<name>` on the server.

```yaml
run:
  volumes: ["uploads:/app/public/uploads", "data:/data"]
```

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

## healthcheck

| Field | Type | Default | Accepted |
| --- | --- | --- | --- |
| `path` | text | `/` | starts with `/`, at most 200 characters, no spaces or quotes |
| `timeout` | text | `30s` | `ms`, `s` or `m` (`45s`, `2m`), from 1s to 10m |

After the new container starts, the proxy container requests `path` from it until it answers successfully or `timeout` passes. Traffic switches only after it succeeds; otherwise the new container is removed and the previous release keeps serving.

```yaml
healthcheck: { path: /api/health, timeout: 1m }
```

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

## permissions

| Field | Type | Default | Accepted |
| --- | --- | --- | --- |
| `deploy` | text | `operate` | `operate`, `manage` |

Who may deploy and roll back this app in BastionSSH: members with **operate** access to Deployments on the server (the default), or only those with **manage**. Restart and stop still need operate. See [Permissions](permissions.md#permissionsdeploy).

```yaml
permissions: { deploy: manage }
```
