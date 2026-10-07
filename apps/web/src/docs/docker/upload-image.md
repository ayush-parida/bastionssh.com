---
title: Deploy an image built on your machine
section: docker
order: 60
summary: Build a Docker image on your own computer, upload it to a server with Upload image, and update the Compose service that runs it — no registry, no scp, no SSH one-liner.
keywords: [upload image, docker save, docker load, docker build, platform, amd64, arm64, exec format error, compose up, no-deps, tar.gz, image archive, deploy]
---

If you build your images on your own computer and copy them to the server — `docker save`, `scp`, `docker load`, then `docker compose up -d` — **Upload image** on a server's Docker page does the copying and loading for you, and can then recreate the Compose service that uses the image.

The image file goes straight from your browser into the server's Docker Engine over the server's SSH connection. Nothing is written to disk on the BastionSSH host or on the server along the way.

## When to use it

| You want to… | Use |
| --- | --- |
| Run an image you build yourself, on a server where it runs under Docker Compose | **Upload image** (this page) |
| Deploy a static site, a Next.js app or a project with a Dockerfile, built on the server, with HTTPS and rollbacks | [Deployments](/docs/deployments/overview) |
| Run an image that is already in a registry (Docker Hub, GHCR, your own) | **Pull image** on the Docker page, or **Pull** on the Compose service ([Compose projects](/docs/docker/compose-projects)) |

Upload image fits best when the server has no access to your registry, when you do not use a registry at all, or when you already deploy with a compose file on the server and only want to replace one service's image.

## Prerequisites

- **Docker found on the server.** Open **Servers → the server → Docker**; if the containers list loads, you are set. See [Docker on servers](/docs/docker/docker-on-servers) otherwise.
- **The operate level on the server**, as for pulling images (see [Who can do what](#who-can-do-what)).
- To update a service from the dialog: **a Compose project on the server whose service uses the tag you upload.** In the compose file on the server, the service's `image:` must be exactly the tag you build, for example:

```yaml
services:
  website:
    image: knexbi-website:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
```

The service needs no `build:` section: the image is built on your machine, not on the server. If the compose file has both `build:` and `image:`, Compose uses the image that is already loaded and does not rebuild unless asked to.

The project must have been started once on the server (`docker compose up -d` in its folder), because BastionSSH finds Compose projects from their containers — see [How projects are found](/docs/docker/compose-projects#how-projects-are-found). The Docker CLI with the Compose plugin must be installed on the server for the update step.

## Step by step

The example deploys a website built from the `knexbi.com/` folder as `knexbi-website:latest`, to a server where the Compose project in `~/infra` has a `website` service with `image: knexbi-website:latest`.

### 1. Build for the server's platform

On your own computer, in the folder above your project:

```sh
docker build --platform linux/amd64 -t knexbi-website:latest knexbi.com/
```

`--platform` must match the server. Most servers are `linux/amd64`; the Upload image dialog shows the server's platform as its Docker Engine reports it. A Mac with Apple silicon builds `linux/arm64` images unless told otherwise, and those fail on an amd64 server with `exec format error`.

### 2. Save it to a file

```sh
docker save knexbi-website:latest | gzip > knexbi-website.tar.gz
```

Gzip usually makes the file several times smaller, so the upload is faster. Docker Engine reads `.tar`, `.tar.gz`, `.tar.xz` and `.tar.bz2` archives, and `.tar.zst` from Docker 23 on — upload the file as it is; it is not unpacked on the way.

> **Tip:** The **How to build and save the image** panel in the dialog fills in both commands from the image name you type, with the server's platform, and copies them with one click. It remembers the name for next time (in your browser only).

### 3. Upload it

1. Open **Servers → the server → Docker**.
2. Click **Upload image** (next to **Pull image**).
3. Choose `knexbi-website.tar.gz` and click **Upload**.

The bar shows how much has been sent. Once the whole file is on its way, Docker loads it, and the dialog lists what was loaded: the tag, the image id and its platform, and which image the tag pointed at before (the one it **replaces**).

If the image was built for another platform than the server's, the dialog says so in a warning — rebuild with the right `--platform` before going further.

Closing the dialog while the file is still uploading cancels the upload, and nothing is loaded.

### 4. Update the service

After a successful upload, **Then update a Compose service** offers the project and service to recreate. A service whose `image:` is one of the uploaded tags is picked for you; otherwise the dialog picks the one you used last time on this server.

1. Check the project and service. The dialog shows the service's configured image and warns if it is not the tag you uploaded.
2. Leave **Remove the image this replaced if nothing uses it** ticked to clean up the old image (see below), or untick it to keep it for a quick manual rollback.
3. Click **Update website**.

This runs `docker compose up -d --no-deps website` in the project's folder and shows its output. Compose sees the tag now points at a new image and recreates only that service's container; the services next to it (a database, a cache) keep running.

With the cleanup ticked, the old image is removed afterwards — but only if it has no tag left and no container (running or stopped) uses it. It is removed by its id, so another tag can never be taken away; if anything still uses it, it is kept and the dialog says why.

## The same as your old one-liner

What used to be one long command:

```sh
docker build --platform linux/amd64 -t knexbi-website:latest knexbi.com/ \
  && docker save knexbi-website:latest | gzip > /tmp/knexbi-website.tar.gz \
  && scp /tmp/knexbi-website.tar.gz server:/tmp/ \
  && ssh server 'gunzip -c /tmp/knexbi-website.tar.gz | sudo docker load && cd ~/infra && sudo docker compose up -d website'
```

maps onto BastionSSH like this:

| Old step | Now |
| --- | --- |
| `docker build --platform linux/amd64 …` | The same, on your machine (step 1) |
| `docker save … \| gzip > ….tar.gz` | The same, on your machine (step 2) |
| `scp` to the server, `gunzip -c … \| docker load` | **Upload image** (step 3) — no file is left in `/tmp`, and no SSH key or `sudo` on your laptop is needed |
| `cd ~/infra && docker compose up -d website` | **Then update a Compose service** (step 4), as `up -d --no-deps website` |

Everything is recorded in the audit log under your name: the upload as `docker.image_load` (file name, size, the loaded tags and ids), the update as `docker.compose_up` with the service and its exit code.

## Actions on one service

The Compose tab can also act on a single service, without the upload. Each service row has four buttons:

| Button | Runs | Use it to |
| --- | --- | --- |
| **Up** | `docker compose up --detach --no-deps <service>` | Recreate the service after its image or configuration changed |
| **Restart** | `docker compose restart <service>` | Restart its containers as they are (a new image is **not** picked up) |
| **Pull** | `docker compose pull <service>` | Pull its image from its registry; follow with **Up** |
| **Stop** | `docker compose stop <service>` | Stop its containers (they are kept) |

They ask first, stream the output like project actions, and are audited with the service name. One action at a time runs per project. See [Compose projects](/docs/docker/compose-projects).

## Who can do what

| Level on the server | Can |
| --- | --- |
| view | See projects, services and images |
| operate | Also upload images, run Up, Restart, Pull and Stop on a service, and tick **Remove the image this replaced** — the same as pulling images |

The cleanup only ever removes an image with no tags left that no container (running or stopped) uses, so it needs no more than an upload does. Removing any other image from the Images list still needs the remove permission (manage, or operate when your org lets operators remove images).

Each upload takes one of your 8 live streams (the same count as log and stats views) from the moment it starts until Docker has loaded the image.

## Size limit

An upload may be at most **5 GiB** by default. Whoever runs BastionSSH sets this with `SMT_DOCKER_IMAGE_UPLOAD_MAX_BYTES` (in bytes); the dialog shows the limit and checks the file before sending it. A file over the limit is refused before anything reaches Docker.

If BastionSSH sits behind a reverse proxy, the proxy's own body size limit applies first — for nginx, `client_max_body_size` (1 MB by default). Set it at least as high as the BastionSSH limit, or uploads fail with a lost connection or a 413 from the proxy.

Two more nginx defaults get in the way of large uploads:

- `proxy_request_buffering on` makes nginx write the whole file to its own disk before passing any of it on. Set `proxy_request_buffering off` for BastionSSH so the file streams through, as it does without a proxy.
- `proxy_read_timeout 60s` gives up when BastionSSH sends nothing for a minute. BastionSSH answers only once Docker has read the whole file and starts loading it, which for a large image can take longer. Raise it (for example `proxy_read_timeout 30m;`).

The Caddy configuration that ships with BastionSSH needs none of this: Caddy streams request bodies and has no such limits by default.

## Troubleshooting

### The container fails with exec format error

The image was built for another CPU architecture than the server's — typically `linux/arm64` from an Apple silicon Mac, on a `linux/amd64` server. The upload dialog warns about this after loading. Rebuild with `docker build --platform linux/amd64 …` (or whatever platform the dialog shows for the server), save and upload again.

### No such image, or the service still runs the old version

The tag you built is not the one the service uses. Compare the tag in the dialog's **Loaded** list with the service's `image:` in the compose file — `knexbi-website:latest` and `knexbi-website:v2` are different tags, and so are `knexbi-website` and `knexbi/website`. The update step shows the service's configured image and warns when they differ. Either rebuild with the right tag or change `image:` in the compose file on the server.

If the tags match and the old container is still running, the service was **restarted** rather than recreated. `restart` keeps the container and its image; use **Up** (`up -d --no-deps`), which recreates the container when its image changed.

### No space left on device

Docker needs room for the unpacked image, which is usually two to three times the size of the `.tar.gz`. Free space on the server — **Prune…** on the Docker page (admins) removes stopped containers and unused images — or remove old images of the same app. Ticking **Remove the image this replaced** keeps old versions from piling up.

### Permission denied on the Docker socket

The server's SSH user may not use the Docker socket, so the Docker page itself shows an error. Add the user to the `docker` group, as described in [Giving the SSH user access to the socket](/docs/docker/docker-on-servers#giving-the-ssh-user-access-to-the-socket). Your old one-liner used `sudo docker`; BastionSSH needs the user to reach the socket without `sudo`.

### Upload too large

The dialog says the file is over the limit before sending it: make the image smaller (a slimmer base image, a multi-stage build), make sure the file is gzipped, or ask whoever runs BastionSSH to raise `SMT_DOCKER_IMAGE_UPLOAD_MAX_BYTES`. If the upload stops partway with **The connection to BastionSSH was lost**, a reverse proxy in front of BastionSSH is likely limiting request bodies — see [Size limit](#size-limit).

### This is not an image archive

The file is not what `docker save` writes — for example a `.zip`, or a build folder packed with `tar` instead of a saved image. Run `docker save <image> | gzip > file.tar.gz` and upload that file.

### Private base images

Not a problem here: the image is built on your machine, with your registry logins, and uploaded complete. The server never pulls the base images, so it needs no registry credentials.

## Related

- [Compose projects](/docs/docker/compose-projects) for project and service actions
- [Containers & actions](/docs/docker/containers-and-actions) for pulling and removing images
- [Docker on servers](/docs/docker/docker-on-servers) for setup and permissions
- [Deployments](/docs/deployments/overview) for apps built on the server
