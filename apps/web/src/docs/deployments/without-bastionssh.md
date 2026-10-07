---
title: Deploying without BastionSSH
section: deployments
order: 100
summary: Run bastionctl over plain SSH — deploy, roll back, edit config and secrets from a shell or CI.
keywords: [cli, ssh, shell, ci, bastionctl, command line, scp, tar, deploy, rollback, script, automation]
---

Everything BastionSSH does, it does by running `bastionctl` on the server. You can run it yourself over SSH — from a terminal, a script or CI — and BastionSSH shows the result next time its tab opens. The server must have been set up once (from BastionSSH, which installs `bastionctl`).

`bastionctl` is at `<root>/bin/bastionctl` — `/opt/bastion/bin/bastionctl`, or `~/bastion/bin/bastionctl`. The examples assume `/opt/bastion`.

## Deploy

1. Make a tarball **with the project at its root** (the server does not drop a top-level folder the way the browser does):

   ```sh
   tar -czf site1.tar.gz --exclude=node_modules --exclude=.next --exclude=.git -C my-site .
   ```

   For a static export, `tar -czf site1.tar.gz -C out .` with `output: .`.

2. Copy it into the deployments folder — `bastionctl` only reads files inside it:

   ```sh
   scp site1.tar.gz deploy@server:/opt/bastion/tmp/
   ```

3. Deploy:

   ```sh
   ssh deploy@server /opt/bastion/bin/bastionctl deploy site1 --source /opt/bastion/tmp/site1.tar.gz
   ```

The log goes to standard error; the exit code is 0 on success. The uploaded file is moved into the release. Add `--json` for one line of JSON on standard output, which is what BastionSSH reads.

The release records who deployed it from `BASTION_ACTOR` if set, else the SSH user: `ssh deploy@server BASTION_ACTOR=ci-pipeline /opt/bastion/bin/bastionctl deploy …`.

> **Note:** In [nginx mode](nginx.md), BastionSSH runs the nginx helper after a deploy. From a shell, run `sudo bastion-nginx apply /opt/bastion site1` yourself when the app is new or its domains changed.

## Commands

```text
bastionctl setup [--proxy caddy|nginx]             Network, proxy container and folders (safe to repeat)
bastionctl init <app> [--config <file>] [--force]  Create an app (template, or a bastion.yml file)
bastionctl validate <app> [--file <file>]          Check a config (default: the app's bastion.yml)
bastionctl list                                    Apps with their current release and container
bastionctl status <app>                            One app in detail
bastionctl releases <app>                          An app's releases, newest first
bastionctl certs <app>                             Certificates of the app's domains
bastionctl deploy <app> --source <file>            Build and serve an upload (.tar or .tar.gz)
bastionctl deploy <app>                            Pull and serve build.image (build.type: image)
bastionctl rollback <app> <release> [--force-line] Serve a kept release again (no rebuild); a quick service's
                                                   release on another version line is refused unless --force-line
bastionctl restart <app> | stop <app>              The app's live container
bastionctl env keys|set|unset|get <app> [KEY]      .env: names only; set reads the value from stdin
bastionctl env generate <app> <KEY> [--bytes N] [--if-missing]
                                                   A random URL-safe value into .env (never printed)
bastionctl exec <app> -- <program> [args…]         Run a program in the app's live container
bastionctl delete <app> [--purge]                  Remove an app (--purge: also config, .env, volumes)
bastionctl proxy apply                             Regenerate and reload the proxy config
bastionctl proxy status                            The proxy against this bastionctl (read-only)
bastionctl proxy upgrade                           Replace an outdated proxy now (even when pinned)
bastionctl version
```

Every command takes `--json`. File arguments must be inside the deployments folder. `deploy` and `rollback` take `--drain <seconds>` (default 10): how long both releases serve before the old container stops.

## Config and secrets

Create or replace an app's config from a file:

```sh
scp bastion.yml deploy@server:/opt/bastion/tmp/site1.yml
ssh deploy@server /opt/bastion/bin/bastionctl init site1 --config /opt/bastion/tmp/site1.yml --force
```

`init` validates the file first and refuses it with every problem listed. Without `--config` it writes a template.

Secrets — the value is read from standard input, so it never appears in a command line or shell history:

```sh
printf %s "$DATABASE_URL" | ssh deploy@server /opt/bastion/bin/bastionctl env set site1 DATABASE_URL
ssh deploy@server /opt/bastion/bin/bastionctl env keys site1
```

Changes apply at the next deploy ([why](environment.md#runtime-variables-the-apps-env)).

## Roll back

```sh
ssh deploy@server /opt/bastion/bin/bastionctl releases site1
ssh deploy@server /opt/bastion/bin/bastionctl rollback site1 20261004-090000-12345678
```

## What you do not get from a shell

The audit log in BastionSSH records only what was done through BastionSSH, and its permissions (including [`permissions.deploy`](permissions.md#permissionsdeploy)) apply only there. Anyone with SSH access to a user that can run Docker can do anything on the server.
