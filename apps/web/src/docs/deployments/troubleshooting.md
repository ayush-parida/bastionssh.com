---
title: Troubleshooting deployments
section: deployments
order: 120
summary: What the common deploy failures mean and how to fix them — wrong folder uploaded, missing build script, standalone output, health checks, DNS, ports, Reinstall, memory and certificates.
keywords: [error, failed, troubleshooting, missing script build, standalone, health check, dns, port 80, port 443, address already in use, integrity, reinstall, out of memory, oom, killed, 137, certificate, next build folder]
---

When a deploy fails, the previous release keeps serving. The deploy log ends with the reason, and failures this page knows about link here.

## Missing script: build

**You see** `npm error Missing script: "build"` in the build log, or the deploy is refused with *package.json has no build script*.

**Why.** A static app with a `package.json` is built with its `build` script. The usual cause is uploading a folder that has `package.json` but is not the project — most often the project's built output together with `package.json` (`.next/` and `out/` next to it) — or a project whose build script has another name.

**Fix.** Either:

- upload only the built site: pick the `out` folder (it contains `index.html`) and set `output: .` — see [which folder to upload](static-site.md#which-folder-to-upload); or
- upload the project and make sure `package.json` has a `build` script (`"build": "next build"`, `"build": "vite build"`).

## Uploaded a Next.js build folder

**You see** *This is Next's .next build folder, not a static export* (or *not your project's source* for a Next.js app), or *out is a Next.js build folder*.

**Why.** The upload has `BUILD_ID`, `required-server-files.json`, or `server/` next to `static/`: that is Next's internal build folder, which only `next start` can serve. `next build` writes it as `.next` — or as `out` when `next.config` sets `distDir: 'out'` without `output: 'export'`.

**Fix.**

- **Static site:** set `output: 'export'` (and `images: { unoptimized: true }`) in `next.config`, remove `distDir`, run `npm run build`, and upload the `out` folder — it contains `index.html`. See [Deploy a static site](static-site.md#nextjs-static-export).
- **App with a server** (API routes, SSR): use `build.type: nextjs` and upload the project source, or build it yourself and deploy the standalone output with `build.type: dockerfile` — see [Deploy a dynamic Next.js app](nextjs-dynamic.md).

## Standalone output required

**You see** *Next.js apps are deployed from Next's standalone output. Add output: 'standalone' to next.config…*

**Why.** `build.type: nextjs` runs the app from Next's standalone server, which is only built with `output: 'standalone'`. The server looks for it, written literally, in `next.config.js`, `.mjs`, `.cjs` or `.ts`.

**Fix.** Add `output: 'standalone'` to the config object and deploy again. If your config computes it (`output: process.env.OUTPUT`), write it literally. If the site has no server-side code, a [static export](static-site.md) is lighter.

## Output folder not found

**You see** *build.output out is not a folder in the upload. At the top of the upload: …*

**Why.** A static app without `package.json` serves `build.output` from the upload as it is, and that folder is not there. Usually the folder's *contents* were uploaded (you picked `out`, so `index.html` is at the top) while the config still says `output: out`.

**Fix.** Read the list of what was found at the top. If `index.html` is there, set `build.output` to `.`; otherwise upload the folder that contains `out/`, or set `build.output` to the folder your `index.html` is in.

## Upload has no package.json

**You see** *build.type is nextjs but there is no package.json in the upload.*

**Why.** A Next.js app is built from its source, starting with `package.json`. A folder above or below the project was picked, or `build.dir` points elsewhere.

**Fix.** Pick the folder you run `npm run build` in, or set `build.dir` to where `package.json` is inside the upload (`apps/web`).

## No Dockerfile in the upload

**You see** *build.type is dockerfile but there is no Dockerfile in …*

**Fix.** Put the `Dockerfile` at the top of the upload (or of `build.dir`); the name is case-sensitive. See [Deploy with your own Dockerfile](dockerfile.md).

## Health check failed

**You see** *Health check failed after 30s: …* followed by the container's last log lines, or *The new container stopped (exit 1)*.

**Why.** The new container did not answer `GET <healthcheck.path>` successfully in time. Common causes:

- The app listens on another port than `run.port` (3000 by default) — check what it logs at startup.
- It listens on `127.0.0.1` / `localhost` only. It must listen on `0.0.0.0` (the generated Next.js image sets `HOSTNAME=0.0.0.0`; your own server must do the same).
- It crashed at startup — often a missing environment variable. The log lines show the error; add the variable under **Environment** and deploy again.
- The health path answers an error (404, 500): point `healthcheck.path` at a page that answers 200, such as `/api/health`.
- A slow start (migrations, cache warm-up): raise `healthcheck.timeout`, up to `10m`.
- A static site without `index.html` at the top of the served folder.

The previous release kept serving throughout.

## DNS not pointing at the server

**You see** under **Domains**: *points at 198.51.100.7, not this server*, or no address at all; the certificate is missing.

**Fix.** Create or correct the records the Domains tab shows (A to the server's IPv4 address; AAAA only if the server answers on IPv6 — or remove a stale AAAA). Wait for DNS to update, then check **Domains** again; the certificate follows on the proxy's next try. See [DNS records](domains-https.md#dns-records).

## Ports 80 or 443 already in use

**You see** at setup: *Ports 80/443 are taken by something else on this server (… address already in use).*

**Why.** Another web server (nginx, Apache, another Caddy or Traefik, a container publishing 80/443) owns the ports the proxy needs.

**Fix.** Find it with `sudo ss -ltnp 'sport = :80 or sport = :443'`. If it is nginx serving other sites, use [nginx mode](nginx.md) (`setup --proxy nginx`, or choose nginx before **Set up**). Otherwise stop and disable it, then run setup again.

## Integrity check failed: Reinstall

**You see** *bastionctl needs reinstalling*, or *The bastionctl on this server is not the version this BastionSSH ships (or it was modified). Reinstall it with Set up.*

**Why.** Before every command BastionSSH checks the server's `bastionctl` against its own copy. After a BastionSSH update the shipped version is new, so every server asks for this once; a file edited on the server is refused for the same reason.

**Fix.** Click **Reinstall** on the Deployments tab (manage access). Your apps, configs, secrets and releases are untouched. See [Reinstall](overview.md#reinstall).

## Build ran out of memory

**You see** the build stop with `Killed`, `exit code: 137`, `JavaScript heap out of memory`, or `FATAL ERROR: Reached heap limit`.

**Why.** The build used more memory than the server has free. `next build` alone wants 1–2 GB.

**Fix.**

- Add swap (2 GB is plenty for most builds):

  ```sh
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```

- Or build on your machine or in CI and upload the result ([option 2](nextjs-dynamic.md#option-2-build-yourself-upload-only-the-build), or a [static export](static-site.md)).
- Or move to a bigger server ([sizing](releases-rollback.md#resource-limits-and-server-sizing)).

## Certificate not issued

**You see** no certificate (or an error) for a domain under **Domains** or in the app list, and browsers warn about the site.

Check, in order:

1. **DNS** points at this server — see [above](#dns-not-pointing-at-the-server).
2. **Ports 80 and 443** are open to the internet: the Domains tab reports *filtered* when they do not answer. Open them in the server's firewall (`ufw allow 80,443/tcp`) and your cloud provider's security group.
3. **The last error** under Domains. *rateLimited* / *too many certificates* means a [Let's Encrypt limit](domains-https.md#lets-encrypt-limits): wait for it to pass (the error says until when), and use `tls: staging` while testing.
4. **CAA records** on the domain, if any, must allow `letsencrypt.org`.
5. In **nginx mode**, run **Apply nginx again** under Domains after fixing any of the above; certbot's error is shown there.

The proxy keeps retrying on its own; once the cause is fixed, the certificate usually appears within minutes.
