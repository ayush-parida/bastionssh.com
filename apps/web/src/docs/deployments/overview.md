---
title: How deployments work
section: deployments
order: 10
summary: Deploy web apps to your own servers with Docker — what lives where, what the server needs, and how Setup and Reinstall work.
keywords: [deploy, bastionctl, caddy, setup, reinstall, prerequisites, docker, opt/bastion, overview]
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
| `bastion-caddy` | The proxy container. It owns ports 80 and 443, obtains and renews certificates, and routes each request to the right app by domain. |
| `bastion-<app>-<release>` | One container per app (two for a few seconds during a deploy). Apps are on a private Docker network, `bastion-apps`; nothing but the proxy publishes a port. |

The deployments folder is `/opt/bastion` when the SSH user can write it (Setup creates it with passwordless `sudo` when allowed), otherwise `~/bastion` in the SSH user's home:

```text
/opt/bastion/
  bin/bastionctl, bin/bastionctl.mjs, bin/bastion-nginx
  proxy/Caddyfile                 # generated from every app; never edit
  proxy/data/ proxy/config/       # Caddy's certificates and state
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
2. Choose the proxy (**Automatic** picks nginx mode when an nginx on the host already owns port 80 or 443, Caddy otherwise).
3. Click **Set up deployments**.

Setup creates the folder, installs `bastionctl`, creates the `bastion-apps` network and starts `bastion-caddy`. It is safe to run again: it never touches your apps, their config or their secrets. The checklist under **Prerequisites** on the tab shows what was found (Docker, how the SSH user reaches the socket, whether `sudo` was used, the proxy's state).

Setting up needs **manage** access to Deployments on that server (see [Permissions](permissions.md)).

## Reinstall

Before every command, BastionSSH checks that the `bastionctl` on the server is byte-for-byte the copy it ships (by SHA-256). If it is not, nothing runs and the tab says **bastionctl needs reinstalling**. Click **Reinstall** (or **Reinstall bastionctl**).

You need to reinstall:

- **After updating BastionSSH.** A new version ships a new `bastionctl`, so every server with deployments asks to be reinstalled before the next deploy. Pinned base images (Node.js for builds, Caddy) move with BastionSSH too; a server gets them at its next Reinstall.
- **If someone edited or replaced the files in `bin/`.** A modified program is refused on purpose — it runs with Docker access.

Reinstall is Setup again: it keeps the server's proxy mode and every app. If the proxy image changed in the update, `bastion-caddy` is recreated, so sites are unreachable for a moment; plan reinstalls outside busy hours.

## Creating an app and deploying

1. On the Deployments tab, click **New app**, give it a name (lower case letters, digits and `-`) and its first domain.
2. Edit the config the template starts with — the form or the YAML — and click **Create app**. The server validates it (see the [bastion.yml reference](bastion-yml.md)).
3. Add secrets under **Environment** if the app needs any ([environment variables](environment.md)).
4. Click **Deploy** and pick a folder, a `.zip`, or a `.tar.gz`. The log streams as the server builds.

What a deploy does, in order:

1. Takes the app's deploy lock (one deploy of an app at a time).
2. Unpacks the upload into a new release, checking every path.
3. Checks the upload makes sense for the build type (for example, refuses Next's `.next` folder for a static site — see [Troubleshooting](troubleshooting.md)).
4. Builds the image `bastion-<app>:<release>` — one build per server at a time; others wait their turn.
5. Starts the new container next to the running one and waits for its [health check](bastion-yml.md#healthcheck).
6. Switches traffic to it, then stops the old container after a short drain.
7. Prunes releases beyond `keep_releases`.

If the build or the health check fails, the previous release keeps serving and the failure is in the log and in the release's record.

Which page next:

- [Deploy a static site](static-site.md) — Next.js static export, Vite, plain HTML.
- [Deploy a dynamic Next.js app](nextjs-dynamic.md) — server-side rendering, API routes.
- [Deploy with your own Dockerfile](dockerfile.md) — any language.
