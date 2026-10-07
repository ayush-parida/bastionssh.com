---
title: How deployments work
section: deployments
order: 10
summary: Deploy web apps to your own servers with Docker — what lives where, what the server needs, how Setup and Reinstall work, and how bastionctl and the proxy keep themselves up to date.
keywords: [deploy, bastionctl, caddy, setup, reinstall, upgrade, pinned, version, prerequisites, docker, opt/bastion, overview, proxy upgrade, update proxy now]
---

Deployments put web apps — static sites, Next.js apps, or anything with a Dockerfile — on a server you manage, behind an automatic-HTTPS proxy, with zero-downtime switches and one-click rollback. There is no Git integration and no build service: you upload the source (or a build), the server builds it and serves it.

## The server is the source of truth

Everything about your apps lives **on the server**, in one folder. BastionSSH is only the interface: it uploads, runs commands over SSH, streams the log, and records who did what in the audit log. It keeps no copy of your apps, their configuration, their secrets or their releases — every page of the Deployments tab is read from the server when it opens.

That means:

- A deploy works the same with or without BastionSSH (see [Deploying without BastionSSH](without-bastionssh.md)).
- Two BastionSSH installations (or a teammate with plain SSH) see the same apps.
- Backing up the server's deployments folder backs up your deployments.

## What runs on the server

| Piece | What it is |
| --- | --- |
| `bastionctl` | A single-file program BastionSSH installs. It runs inside a pinned `node:22-alpine` container with the deployments folder and the Docker socket mounted, so the server needs nothing but Docker. |
| `bastion-caddy` | The proxy container. A small front (part of `bastionctl`) owns ports 80 and 443 and hands each connection to Caddy, which obtains and renews certificates and routes each request to the right app by domain. |
| `bastion-<app>-<release>` | One container per app (two for a few seconds during a deploy). Apps are on a private Docker network, `bastion-apps`, where other apps reach each one by its name; nothing but the proxy publishes a port unless an app asks for it with [`run.publish`](bastion-yml.md#runpublish). |

The deployments folder is `/opt/bastion` when the SSH user can write it (Setup creates it with passwordless `sudo` when allowed), otherwise `~/bastion` in the SSH user's home:

```text
/opt/bastion/
  bin/bastionctl, bin/bastionctl.mjs, bin/bastion-nginx
  bin/.pinned                     # optional: never upgrade bastionctl automatically
  proxy/Caddyfile                 # generated from every app; never edit
  proxy/data/ proxy/config/       # Caddy's certificates and state
  proxy/caddy/<id>/caddy          # the Caddy binary the proxy runs (copied from the pinned image)
  proxy/state.json                # the bastionctl build that last brought the proxy up to date
  proxy/mode                      # caddy or nginx, chosen at setup
  tmp/                            # uploads waiting to be deployed
  apps/<app>/
    bastion.yml                   # the app's config
    .env                          # its secrets (mode 0600)
    releases/<id>/                # source, build.log, release.json
    current -> releases/<id>      # the release being served
```

## Prerequisites

- **Docker Engine**, installed and running. Nothing else: no Node.js, no Caddy, no YAML tools on the host.
- **An SSH user that may use Docker**: in the `docker` group, or allowed passwordless `sudo docker`.
- **A folder to work in**: `/opt/bastion` writable by the SSH user, creatable by it, or creatable with passwordless `sudo`; otherwise `~/bastion` is used.
- **Ports 80 and 443 free** for the proxy — or, if the server already runs nginx for other sites, [nginx mode](nginx.md).
- **Memory for builds.** Builds run on the server; a Next.js build alone wants 1–2 GB. See [sizing](releases-rollback.md#resource-limits-and-server-sizing).

> **Warning:** `bastionctl` and the proxy use the Docker socket, which is root-equivalent on the server — the same access Docker management already has. Give Deployments access only to people you would trust with that.

## Setup

1. Open the server's **Deployments** tab (or **Deployments** in the sidebar, then pick the server).
2. Choose the proxy (**Automatic** picks nginx mode when an nginx on the host is running and owns port 80 or 443, Caddy otherwise; on a server set up before, it keeps the mode it has).
3. Click **Set up deployments**.

Setup creates the folder, installs `bastionctl`, creates the `bastion-apps` network and starts `bastion-caddy`. It is safe to run again: it never touches your apps, their config or their secrets. The checklist under **Prerequisites** on the tab shows what was found (Docker, how the SSH user reaches the socket, whether `sudo` was used, the proxy's state).

Setting up needs **manage** access to Deployments on that server (see [Permissions](permissions.md)).

## Automatic upgrades

Before every command, BastionSSH checks that the `bastionctl` on the server is byte-for-byte the copy it ships (program and wrapper, by SHA-256). When it is not — usually because BastionSSH was updated and ships a newer `bastionctl` — BastionSSH installs its own copy over the old one, checks the hashes of what it wrote, and then runs your command. There is nothing to click: opening the Deployments tab, a deploy, or the background certificate check all do it, and a toast says **bastionctl upgraded to …** when it happens while you watch.

- It only replaces the two files in `bin/` (and refreshes the `bin/bastion-nginx` copy in [nginx mode](nginx.md) if it is there). The network, the proxy and your apps are not touched, and a server that was never set up stays that way.
- Each file is written beside the old one and renamed over it, so a deploy already running keeps going on the version it started with. The first command after an upgrade can take a little longer when Docker has to pull the Node.js image the new `bastionctl` runs in.
- Every upgrade is in the audit log as **deploy.bastionctl_upgrade**, with the version it went from and to, under the member whose request triggered it (or *system* for the background check).
- It needs the SSH user to be able to write `bin/` in the deployments folder, as it can after Setup. If writing fails, the command is refused as before, with the reason, and the tab shows **bastionctl could not be upgraded** — fix the permissions or click **Reinstall bastionctl**.

The version shown on the tab is `0.1.0+<build>`: the build is the first 7 characters of the hash of the shipped files, so two BastionSSH versions that ship the same `bastionctl` show the same build. A server installed before builds were numbered shows plain `0.1.0` until it is upgraded. `bastionctl version` on the server prints the same.

## Proxy upgrades

A BastionSSH update can also ship a newer proxy: another Caddy, or a changed proxy front. The proxy is brought up to date **automatically**, at the start of the next command that changes traffic anyway — a deploy, rollback, restart, `bastionctl proxy apply`, or Setup/Reinstall. Reading anything (opening the tab, the app list, logs) never touches it. The Setup line on the Deployments tab shows **Proxy … up to date**, or **outdated** with what an update would replace and an **Update proxy now** button (members with **operate** access) that does it right away.

- **Only Caddy changed** (the common case): the new Caddy is started *behind* the running proxy front, which keeps the ports. It takes new connections once it serves every certificate the old one does; the old one finishes the connections it has. **No connection is dropped**, and the `bastion-caddy` container is not replaced.
- **The front itself changed** (or the proxy was created by a `bastionctl` from before proxy upgrades): the container is replaced. The old one is moved aside and stopped, the new one started, and the old one is removed only once the new one accepts connections. While the ports move between them, connections in flight **can drop for about a second**; the deploy log says so. Browsers and most clients retry.
- **If the new proxy does not come up**, the previous one is put back and started, and the command goes on with it (the log says *the proxy upgrade failed*). The next command tries again.
- Every attempt is in the audit log as **deploy.proxy_upgrade**: the `bastionctl` build it went from and to, the command that triggered it (`deploy`, `rollback`, `restart`, `proxy_apply`, `setup` or `manual` for Update proxy now), the result, and what was replaced (`caddy`, `front`).
- A [pinned](#pinning) server's proxy is not upgraded automatically; Update proxy now and Reinstall still do it.

From a shell: `bastionctl proxy status` (read-only) and `bastionctl proxy upgrade`.

## Pinning

To keep a server on the `bastionctl` it has — while you test a BastionSSH update on another server first, say — pin it by creating an empty file named `.pinned` in its `bin/` folder:

```sh
touch /opt/bastion/bin/.pinned        # or ~/bastion/bin/.pinned
```

A pinned server is never upgraded automatically — neither `bastionctl` nor [the proxy](#proxy-upgrades). While its `bastionctl` matches the shipped one nothing changes (the tab shows **pinned** next to the version); once BastionSSH ships a different one, commands on that server are refused and the tab says **bastionctl is pinned**, as before automatic upgrades. To unpin, remove the file and reload the tab — the next request upgrades it:

```sh
rm /opt/bastion/bin/.pinned
```

**Reinstall bastionctl** installs the shipped copy on a pinned server too; the pin stays in place.

## Reinstall

**Reinstall** on the Deployments tab is Setup again: it installs the shipped `bastionctl` (whether or not the server is pinned), then makes sure of the network and the proxy, [upgrading the proxy](#proxy-upgrades) the same careful way a deploy does (pinned or not). It keeps the server's proxy mode and every app, config, secret and release.

Since `bastionctl` and the proxy both upgrade themselves, you rarely need it:

- **When an automatic upgrade cannot run**: the server is pinned, or the SSH user cannot write `bin/`.
- **If the network or the proxy container was removed or changed by hand.**
- **To switch the proxy mode** (Caddy or nginx), which replaces the proxy container.

## Creating an app and deploying

1. On the Deployments tab, click **New app**, give it a name (lower case letters, digits and `-`, at most 41 characters) and its first domain, and click **Next**.
2. Edit the config the template starts with — the form or the YAML — and click **Create app**. The server validates it (see the [bastion.yml reference](bastion-yml.md)).
3. Add secrets under **Environment** if the app needs any ([environment variables](environment.md)).
4. Click **Deploy** and pick a folder, or an archive (`.zip`, `.tar.gz`, `.tgz` or `.tar`). The log streams as the server builds.

An upload may be up to 1 GiB (the BastionSSH host's `SMT_SFTP_MAX_UPLOAD_BYTES`), and may unpack to at most 2 GiB and 200,000 entries. A deploy, build included, must finish within 30 minutes. If you close the page, the deploy keeps running to its end.

What a deploy does, in order:

1. Takes the app's deploy lock (one deploy of an app at a time).
2. Unpacks the upload into a new release, checking every path.
3. Checks the upload makes sense for the build type (for example, refuses Next's `.next` folder for a static site — see [Troubleshooting](troubleshooting.md)).
4. Builds the image `bastion-<app>:<release>` — one build per server at a time; others wait their turn.
5. Starts the new container next to the running one and waits for its [health check](bastion-yml.md#healthcheck).
6. Switches traffic to it, then stops the old container after a drain of 10 seconds.
7. Prunes releases beyond `keep_releases`.

If the build or the health check fails, the previous release keeps serving and the failure is in the log and in the release's record.

Which page next:

- [Deploy a static site](static-site.md) — Next.js static export, Vite, plain HTML.
- [Deploy a dynamic Next.js app](nextjs-dynamic.md) — server-side rendering, API routes.
- [Deploy with your own Dockerfile](dockerfile.md) — any language.
