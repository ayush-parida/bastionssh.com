---
title: Environment variables and secrets
section: deployments
order: 60
summary: Runtime secrets in the app's .env on the server, build-time NEXT_PUBLIC_* values, editing and revealing them, and how they are kept out of logs.
keywords: [env, .env, environment, secrets, variables, NEXT_PUBLIC, build time, runtime, reveal, passkey, mask, masking, database_url, api key]
---

## Runtime variables: the app's .env

Each app has a `.env` file on the server, next to its `bastion.yml` (`<root>/apps/<app>/.env`, mode `0600`; `run.env_file` can name another file in the app folder). Its `KEY=value` lines become the container's environment variables.

```text
DATABASE_URL="postgres://app:…@db.internal:5432/app"
STRIPE_SECRET_KEY="sk_live_…"
```

- The values are given to the container **when it is created**: at each deploy, rollback and restart. They are not part of the image, the upload or any release.
- **Restart applies changes without a rebuild**: it starts a fresh container of the current release with the `.env` (and volumes, limits and domains) as they are now, health-checks it, switches traffic to it and then stops the old one — no downtime. If the new container fails its health check, the old one keeps serving.
- `NEXT_PUBLIC_*` values are the exception: they are baked into the build, so changing one needs a new deploy.
- Names are letters, digits and `_`, not starting with a digit, at most 128 characters. A value may be up to 64 KiB, the whole file up to 256 KiB.

> **Note:** The build does not see `.env`. Builds use only the upload, so a secret is never baked into an image.

## Build-time values: NEXT_PUBLIC_*

Next.js replaces `process.env.NEXT_PUBLIC_…` in your code with its value **while it builds**, so the value ends up in the JavaScript sent to browsers. It must exist at build time, and setting it in the server's `.env` afterwards changes nothing.

- **Server builds from source** (`build.type: nextjs` or a `static` build): put the values in a `.env.production` file in the project you upload. Next reads it during `next build`.
- **You build** ([option 2](nextjs-dynamic.md#option-2-build-yourself-upload-only-the-build)): have them in your environment or `.env.production` when you run the build.

Only put values in `.env.production` that may be public — they are in the upload, which the server keeps with each release, and in the site's JavaScript. Everything secret belongs in the server's `.env`.

> **Tip:** Pages Next pre-renders at build time also see only build-time values. Read runtime secrets in code that runs per request — route handlers, server actions, or pages marked `export const dynamic = 'force-dynamic'`.

The same applies to other frameworks that inline variables at build time (Vite's `VITE_*`, Create React App's `REACT_APP_*`).

## Editing from BastionSSH

The app's **Environment** tab (members with **manage** access to Deployments on the server) lists the variable **names** only:

- **Add variable** — a name and a value.
- **Change** — the field starts empty; the old value is never shown in the form.
- **Remove** — after a confirmation.
- **Reveal** — shows one value. It asks for your **passkey** first (a step-up, even if you signed in moments ago), works only from a browser session, and is recorded in the audit log with the variable's name.

Values are sent to the server's `bastionctl` on standard input, never on a command line, and the audit log records changes by variable name, never value.

## Masking in logs

A deploy's log, `build.log` and the release's record never show a `.env` value of 6 characters or more: each occurrence is replaced by `••••`. This covers the value as written, each line of a multi-line value, and its JSON-escaped form — enough for a crash or health-check log that prints it.

It cannot recognise a value that is shorter than 6 characters, or that the app prints transformed (base64, URL-encoded, hashed, split differently). Apps should not print secrets at all.

## Deploying runs code with the app's secrets

A deploy starts the uploaded code with every value in the app's `.env` and access to its volumes. Whoever may deploy an app can therefore read its secrets — by deploying code that prints or sends them. That is why the Deploy dialog says so, and why you can require **manage** access to deploy an app with [`permissions.deploy: manage`](permissions.md#permissionsdeploy).

## From a shell

```sh
bastionctl env keys site1                                 # names only
printf %s 'postgres://…' | bastionctl env set site1 DATABASE_URL   # value from stdin
bastionctl env unset site1 OLD_KEY
```

See [Deploying without BastionSSH](without-bastionssh.md).
