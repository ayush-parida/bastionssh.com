---
title: Using nginx instead of Caddy
section: deployments
order: 90
summary: Nginx mode for servers that already run nginx for other sites — what changes on the host, the one-time sudo setup, and its limits.
keywords: [nginx, certbot, sudo, sudoers, bastion-nginx, helper, reverse proxy, existing nginx, conf.d, http.d, port 80, port 443]
---

By default the `bastion-caddy` container owns ports 80 and 443. On a server that already runs **nginx** for other sites, those ports are taken — use **nginx mode** instead: your nginx keeps the ports and forwards each app's domains to the deployments proxy.

| | Caddy (default) | nginx mode |
| --- | --- | --- |
| For | servers with nothing on ports 80/443 | servers that already run nginx |
| Ports 80/443 | the `bastion-caddy` container | your nginx; `bastion-caddy` listens on `127.0.0.1:18480` only |
| Certificates | Caddy, renewed by Caddy | `certbot certonly --webroot`, renewed by certbot's timer, which reloads nginx |
| What changes on the host | nothing outside the deployments folder | one file per app: `/etc/nginx/conf.d/bastion-<app>.conf` (`/etc/nginx/http.d/` on Alpine) |
| TLS options | all | `auto` and `staging` |

Every app still goes through `bastion-caddy`, so zero-downtime switches, health checks and rollbacks work exactly the same; nginx terminates TLS and passes requests on.

## Choosing nginx mode

**Automatic** at a server's first setup picks nginx mode when an nginx on the host is running and owns port 80 or 443. You can also choose **nginx on the host** explicitly. A server keeps the mode it was set up with unless you choose another and set up again; apps' `bastion.yml` must say `proxy: nginx` (a new app's template already does).

## One-time setup on the server

BastionSSH changes nginx only through a small script, `bastion-nginx`, which is the one thing it runs as root. An administrator installs it once, root-owned, and allows the SSH user to run just that command with passwordless `sudo`. The Deployments tab shows these lines with your server's paths and user, and lists only the steps still missing:

```sh
sudo apt-get install -y certbot      # if certbot is not installed
sudo install -o root -g root -m 0755 /opt/bastion/bin/bastion-nginx /usr/local/sbin/bastion-nginx
echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/bastion-nginx' | sudo tee /etc/sudoers.d/bastion-nginx
sudo chmod 0440 /etc/sudoers.d/bastion-nginx
```

(`deploy` is the SSH user BastionSSH connects as.) `/etc/nginx/nginx.conf` must include `/etc/nginx/conf.d/*.conf` inside its `http { }` block — the default on Debian and Ubuntu. On Alpine the files go to `/etc/nginx/http.d/`, which its default config includes.

> **Warning:** After updating BastionSSH, install the helper again when the Deployments tab says it differs: BastionSSH checks it is byte for byte the shipped copy before each use.

## What the helper does

It runs `nginx -t`, `nginx -s reload`, `certbot certonly --webroot` (and `certbot delete` when an app is deleted) — nothing else:

- Writes the app's server block from checked values only: port 80 answers certbot's challenge and redirects to HTTPS once there is a certificate; port 443 terminates TLS and proxies to `127.0.0.1:18480`.
- Puts the previous block back if `nginx -t` or the reload fails, or if `nginx -t` reports one of the app's domains as already claimed by another server block — a site you serve yourself is never taken over.
- Runs after every successful deploy and config change (its output joins the deploy log), and after a delete. **Apply nginx again** under Domains runs it on demand, for example after fixing DNS.

A certbot failure leaves the HTTP block serving and is shown under **Domains** with the error.

From a shell: `sudo bastion-nginx apply /opt/bastion site1`, `sudo bastion-nginx status site1`.

## Limits

- `tls` must be `auto` or `staging`: no wildcards, no internal CA, no certificate files.
- HTTP/1.1 between nginx and the proxy.
- The client address apps see comes from the `X-Forwarded-For` nginx sets (`$remote_addr`, adjusted by your `real_ip` settings if a CDN is in front).
