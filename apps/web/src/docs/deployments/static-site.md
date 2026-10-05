---
title: Deploy a static site
section: deployments
order: 20
summary: Deploy a Next.js static export, a Vite build or plain HTML — and which folder to upload so the server serves it.
keywords: [static, export, out, next.js, nextjs, output export, vite, dist, html, index.html, images unoptimized, trailingSlash, hugo, astro]
---

A static app is a folder of files — `index.html`, CSS, JavaScript, images — served by a small Caddy file server inside the app's container. There is no Node.js process at run time, so it uses a few MB of memory.

With `build.type: static`, the server does one of two things:

- **The upload has a `package.json`**: it installs dependencies, runs the `build` script, and serves `build.output` from the result.
- **No `package.json`**: it serves `build.output` from the upload as it is. Nothing is built.

`build.output` is `out` unless you set it; `.` means the upload's root. The health check asks for `/`, so the served folder must have an `index.html` at its top.

## Next.js static export

A Next.js site with no server-side code (no API routes, no server actions, no `getServerSideProps`, no on-request rendering) can be exported as plain files. Set this in `next.config.js` (or `.mjs` / `.ts`):

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  // The image optimizer needs a Node.js server; an export serves images as they are
  images: { unoptimized: true },
  // Writes about/index.html instead of about.html, so /about works on a plain file server
  trailingSlash: true,
};

export default nextConfig;
```

Then build:

```sh
npm run build
```

The export is written to **`out/`**.

> **Tip:** Keep `trailingSlash: true`. The file server answers `/about` with `about/index.html` (after redirecting to `/about/`), but it does not try `about.html` — without `trailingSlash`, every page but the home page answers 404.

If your site needs a server (API routes, server actions, middleware, `next/image` optimization, revalidation), deploy it as a [dynamic Next.js app](nextjs-dynamic.md) instead.

## What a correct out folder looks like

```text
out/
  index.html          <- required: the home page (and the health check)
  404.html
  about/index.html    <- one folder per page with trailingSlash
  _next/static/...    <- JavaScript and CSS
  favicon.ico, images/...   <- what was in public/
```

## The .next folder is not the site

`next build` always writes a `.next` folder too. It is Next's internal build folder — the input to `next start` — and **not** something a file server can serve. You can recognise it by:

```text
.next/
  BUILD_ID
  build-manifest.json
  required-server-files.json   (or prerender-manifest.json, routes-manifest.json…)
  server/
  static/
  cache/
```

Uploading `.next` (or a project with `.next` and `package.json` but no `build` script) is the most common mistake. The deploy is refused before anything is built, with a link to [Troubleshooting](troubleshooting.md#uploaded-a-nextjs-build-folder).

> **Warning:** Don't set `distDir: 'out'` to "make" an `out` folder. Without `output: 'export'`, Next just writes its build folder (`BUILD_ID`, `server/`, `static/`) under that name. Set `output: 'export'` and leave `distDir` alone.

## Which folder to upload

Pick one of these. The browser drops a single top-level folder when it packs a folder or zip, so **the folder you pick becomes the upload's root**.

### Option 1: pick the out folder itself

Pick `out` in the Deploy dialog's **Folder** option (or zip it). Its contents — `index.html`, `_next/` — are at the upload's root, so set:

```yaml
name: site1
domains: [example.com, www.example.com]
redirect_www: apex
build:
  type: static
  output: .
```

### Option 2: a deploy folder that contains out

Make a folder that contains `out/` (and anything else you like to keep with it, such as a copy of your `bastion.yml` for reference — the server ignores it and uses the app's own config). Pick that folder. Then the default works:

```yaml
build:
  type: static
  output: out
```

### Option 3: upload the project and let the server build it

Pick the project folder (with `package.json`, the lockfile and `next.config`). The browser leaves out `node_modules`, `.next` and `.git`; the server installs dependencies with the package manager the lockfile names (npm, pnpm, yarn or bun), runs `build`, and serves `out`:

```yaml
build:
  type: static
  output: out
  node: "20"     # optional; default: .nvmrc, .node-version, engines.node, else 20
```

Building on the server needs memory (see [sizing](releases-rollback.md#resource-limits-and-server-sizing)); options 1 and 2 need none.

## Vite, React, Vue and other generators

The same rules, with the generator's output folder:

| Tool | Build command | Output folder |
| --- | --- | --- |
| Vite (React, Vue, Svelte…) | `vite build` | `dist` |
| Create React App | `react-scripts build` | `build` |
| Astro (static) | `astro build` | `dist` |
| Hugo | `hugo` | `public` |
| Eleventy | `eleventy` | `_site` |

Either upload the built folder with `output: .`, or upload the project (with a `build` script in `package.json`) and set `output` to the folder in the table. Hugo and other non-Node generators: build on your machine and upload the output.

> **Note:** The file server has no single-page-app fallback: a URL is served only if a file exists for it. A client-side router with "clean" URLs (`/settings` handled in JavaScript) answers 404 when such a URL is opened directly. Use hash routing, pre-render each route to its own `index.html`, or [use your own Dockerfile](dockerfile.md) with a server that falls back to `index.html`.

## Plain HTML

A folder with `index.html` and its assets: pick the folder, set `output: .`. No `package.json` is needed.

## Checks before uploading

When you pick a folder or a zip, the Deploy dialog looks at the files before anything is sent, and refuses (with what to do instead) when:

- the folder is Next's build folder (`BUILD_ID`, `required-server-files.json`, or `server/` next to `static/`);
- there is a `package.json` without a `build` script (the server would fail with "Missing script: build");
- there is no `package.json` and the `output` folder is not in the upload — the message lists what is at the top so you can pick the right folder or set `output: .`.

The server runs the same checks again before building, so a `.tar.gz` (which goes up unopened) or a deploy [from a shell](without-bastionssh.md) gets the same answer.
