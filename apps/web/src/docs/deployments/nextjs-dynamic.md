---
title: Deploy a dynamic Next.js app
section: deployments
order: 30
summary: Run a Next.js app with server-side rendering and API routes — built on the server from source, or built by you and uploaded as a ready image context.
keywords: [next.js, nextjs, standalone, ssr, server, api routes, node, build, docker, platform, amd64, arm64, prebuilt]
---

A dynamic Next.js app runs `next`'s Node.js server in its container: server-side rendering, API routes, server actions, middleware, image optimization. There are two ways to get it there:

| | Option 1: the server builds | Option 2: you build |
| --- | --- | --- |
| `build.type` | `nextjs` | `dockerfile` |
| You upload | the project source | the standalone build and a short Dockerfile |
| Build runs on | the server | your machine or CI |
| Server memory for builds | 1–2 GB free | almost none |
| Effort | least | a few commands per release |

Start with option 1. Choose option 2 when the server is small (1 GB or less), when builds need things only your machine or CI has (private registries, a monorepo's other packages), or when you want the exact build you tested.

## Option 1: the server builds from source

### 1. Turn on standalone output

```js
// next.config.js (or .mjs, .cjs, .ts)
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
};

module.exports = nextConfig;
```

The server reads `next.config.js`, `.mjs`, `.cjs` or `.ts` and looks for `output: 'standalone'` written literally. Without it the deploy stops with "Next.js apps are deployed from Next's standalone output…" (see [Troubleshooting](troubleshooting.md#standalone-output-required)).

### 2. Configure the app

```yaml
name: shop
domains: [shop.example.com]
build:
  type: nextjs
  node: "20"        # optional: 18, 20, 22 or 24
run:
  port: 3000
  memory: 512m      # optional limit for the running app
healthcheck: { path: /, timeout: 30s }
```

### 3. Upload the project folder

Pick the folder that has `package.json` — the same folder you run `npm run build` in:

```text
my-app/
  package.json
  package-lock.json        (or pnpm-lock.yaml, yarn.lock, bun.lock)
  next.config.js
  app/ or pages/, src/ …
  public/
  .env.production          (optional: NEXT_PUBLIC_* values — see below)
```

The browser leaves out `node_modules`, `.next` and `.git` when it packs the folder: the server installs and builds from scratch.

### What the server does

It generates a three-stage Dockerfile (you never edit it):

1. **Dependencies** — installs with the package manager the lockfile names: `npm ci` (or `npm install` with no lockfile), `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile` (`--immutable` for Yarn Berry) or `bun install --frozen-lockfile`.
2. **Build** — runs your `build` script.
3. **Run** — a small image with only `.next/standalone`, `.next/static` and `public`, running `node server.js` as a non-root user, with `PORT` set to `run.port` and `HOSTNAME=0.0.0.0`.

The Node.js version comes from `build.node`, else `.nvmrc` or `.node-version`, else `engines.node` in `package.json`, else 20. Builds use Node.js images pinned by digest, one per major version (18, 20, 22, 24), so a build does not change under you between BastionSSH updates; `22.11` builds on the pinned 22.

### Memory

`next build` wants about **1–2 GB** of memory on its own. On a server with 1 GB, add 2 GB of swap or builds may be killed (see [Troubleshooting](troubleshooting.md#build-ran-out-of-memory)). Only one build runs per server at a time, so several apps do not add up during builds. The running app typically uses 100–300 MB.

### Monorepos

`build.dir` points at the app's folder inside the upload (`build.dir: apps/web`). The build sees only that folder, so an app that depends on other packages of a pnpm, yarn or npm workspace cannot build this way — use option 2, or a [Dockerfile](dockerfile.md) at the workspace root with `build.dir: .`.

## Option 2: build yourself, upload only the build

### 1. Build for the server's platform

Use `output: 'standalone'` as above. Build inside the same Linux image you will run, for the server's CPU — `linux/amd64` for most servers, `linux/arm64` for ARM ones (`uname -m` on the server says `x86_64` or `aarch64`). Native modules (such as `sharp`) are compiled for that platform:

```sh
docker run --rm --platform linux/amd64 \
  -v "$PWD":/app -w /app \
  node:20-alpine sh -c "npm ci && npm run build"
```

`NEXT_PUBLIC_*` values must be set for this build (in `.env.production`, or with `-e NEXT_PUBLIC_API_URL=…`), since Next writes them into the JavaScript.

### 2. Make a deploy folder

```sh
rm -rf deploy && mkdir deploy
cp -R .next/standalone deploy/standalone
cp -R .next/static deploy/standalone/.next/static
cp -R public deploy/standalone/public
```

```text
deploy/
  Dockerfile
  standalone/
    server.js
    package.json
    node_modules/      <- the few modules the server needs
    .next/             <- server code, and static/ copied in
    public/
```

with this `deploy/Dockerfile`, which only copies:

```dockerfile
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY standalone/ ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

Use the same base image (`node:20-alpine`) you built with.

### 3. Configure and upload as a .tar.gz

```yaml
name: shop
domains: [shop.example.com]
build:
  type: dockerfile
run:
  port: 3000
```

> **Warning:** Upload this one as a `.tar.gz`, not as a folder or zip. When the browser packs a folder or zip it leaves out every `node_modules` and `.next` folder — and the standalone build needs both. A tarball goes up exactly as it is.

Make the tarball with the files at its root (no `deploy/` folder inside):

```sh
tar -czf shop.tar.gz -C deploy .
```

Then **Deploy → Archive** and pick `shop.tar.gz`. The server builds the image from your Dockerfile (seconds: it only copies) and switches traffic as usual.

## Environment variables

Runtime secrets (`DATABASE_URL`, API keys) go in the app's `.env` on the server — the **Environment** tab. `NEXT_PUBLIC_*` values are different: Next inlines them into the JavaScript **at build time**, and the server's `.env` is not available to the build. See [Environment variables and secrets](environment.md).
