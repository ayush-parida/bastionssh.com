---
title: Backups & restore
section: operations
order: 20
summary: How BastionSSH backs up its own database on a schedule and before upgrades, copies backups off-site, and restores one.
keywords: [backup, restore, database, sqlite, pre-migration, off-site, object storage, disaster recovery]
---

BastionSSH keeps everything (accounts, servers, SSH keys, encrypted credentials, roles, audit log) in one SQLite file, `/data/smt.db`. It backs that file up by itself using SQLite's online backup, so a backup is consistent even while the app is busy.

## When backups are taken

| Kind | When |
| --- | --- |
| **Scheduled** | Every `SMT_BACKUP_INTERVAL_HOURS` (default 24; `0` turns it off). The timer looks at the age of the newest scheduled backup, so restarts neither skip nor add one. |
| **Before upgrade** (pre-migration) | When a new version is about to change the database. If this backup fails, the upgrade stops and the database is left alone. |
| **Manual** | **Settings → Database backups → Back up now**, or the backup command below. |
| **Before restore** (pre-restore) | Automatically, of the current database, just before a restore replaces it. |

Backups are written to `SMT_BACKUP_DIR` (default `/data/backups`) as `smt-<UTC time>-<kind>.db`, or `.db.gz` with `SMT_BACKUP_GZIP=true`. The newest `SMT_BACKUP_KEEP` (default 14) of **each kind** are kept. Files are readable by their owner only.

### What is left out on purpose

- Live sign-in sessions, pending passkey challenges and pending single sign-on attempts are removed, and invite tokens are replaced. After a restore everyone signs in again, and pending invites must be sent again.
- `SMT_ENCRYPTION_KEY` is **not** in the backup. Without it, the encrypted credentials inside a backup cannot be read. Store the key separately, for example in your password manager.
- Session recordings live in `/data/recordings` and are **not** in the backup. Back that folder up separately if you need them.

## The Database backups panel

Owners of the instance's first organization (the one created on first start) see **Settings → Database backups**. It lists the backups with their kind (Scheduled, Before upgrade, Manual, Before restore), lets you **Back up now**, and lets you download any backup.

Downloading needs a signed-in browser (API tokens cannot) and a passkey confirmation when the owner has a passkey, because the file contains the whole instance. Creating and downloading backups, and failures, are recorded in the audit log.

## Keep a copy off the host

A backup inside the data volume does not survive losing that volume. Choose one:

- **Another volume.** Mount a different disk or volume at `/data/backups`.
- **Object storage.** Copy every scheduled and manual backup to a bucket:
  1. Add the bucket's provider in **Object Storage** (see [Object storage](/docs/files/object-storage)).
  2. Copy the connection id from the address bar (`/storage/<id>`).
  3. Set these on the `smt` container and restart it:

     ```bash
     SMT_BACKUP_STORAGE_CONNECTION_ID=<connection id>
     SMT_BACKUP_STORAGE_BUCKET=my-backups
     SMT_BACKUP_STORAGE_PREFIX=bastionssh-backups/   # optional, this is the default
     ```

Uploaded copies are **encrypted** with a key derived from `SMT_ENCRYPTION_KEY` and named `<backup>.enc`, because anyone who can browse that connection in the app could otherwise download the database. A failed upload is logged and audited, and the local copy is kept. Old copies in the bucket are not deleted; use a lifecycle rule on the bucket for that.

> **Note:** `SMT_BACKUP_STORAGE_BUCKET` is required when `SMT_BACKUP_STORAGE_CONNECTION_ID` is set; the server will not start otherwise.

## Taking a backup from the command line

```bash
# Docker Compose (from deploy/docker)
docker compose exec smt node apps/server/dist/cli/backup.js

# From source
pnpm --filter @smt/server run db:backup
```

A backup taken this way stays local: copies to object storage are only made by the running server (scheduled backups and **Back up now**).

## Restoring a backup

A restore replaces the whole database, so the server must be **stopped**. The restore command refuses to run while the server is up (it checks a lock file next to the database and the port). It then:

1. checks the backup with SQLite's `integrity_check`,
2. saves the current database as a **pre-restore** backup,
3. swaps the backup in.

With Docker Compose:

```bash
cd deploy/docker
docker compose exec smt ls -l /data/backups          # pick a backup
docker compose stop smt
docker compose run --rm --no-deps smt \
  node apps/server/dist/cli/restore.js smt-20260928T031500Z-scheduled.db
docker compose start smt
```

A bare file name is looked up in `SMT_BACKUP_DIR`; a full path works too, for example a backup you downloaded and copied into the volume. From source, use `pnpm --filter @smt/server run db:restore -- <name or path>`.

On start, the server applies any migrations newer than the restored database (taking a pre-migration backup of it first). Everyone then signs in again.

### Restoring an off-site copy

1. Download the `.enc` file from your bucket.
2. Copy it into the data volume, for example with `docker compose cp smt-….db.enc smt:/data/backups/`.
3. Run the restore command above with its name. It decrypts with `SMT_ENCRYPTION_KEY` from the environment, which the compose file already sets.

> **Warning:** A backup restored with a different `SMT_ENCRYPTION_KEY` opens, but none of the stored SSH keys, passwords or tokens can be decrypted. Always restore with the key the instance used when the backup was taken.

### Rolling back an upgrade

If an upgrade goes wrong, stop the container, switch the image back to the previous version, and restore the **Before upgrade** backup that the new version took. Starting the newer version again would migrate it once more.

## Settings reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMT_BACKUP_DIR` | `/data/backups` | Where backups are written |
| `SMT_BACKUP_INTERVAL_HOURS` | `24` | Scheduled interval; `0` = off |
| `SMT_BACKUP_KEEP` | `14` | Newest kept per kind |
| `SMT_BACKUP_GZIP` | `false` | Compress backups |
| `SMT_BACKUP_PRE_MIGRATION` | `true` | Back up before upgrades change the database |
| `SMT_BACKUP_STORAGE_CONNECTION_ID` | unset | Object storage connection for off-site copies |
| `SMT_BACKUP_STORAGE_BUCKET` | unset | Bucket for off-site copies |
| `SMT_BACKUP_STORAGE_PREFIX` | `bastionssh-backups/` | Key prefix in the bucket |

`SMT_BACKUP_PRE_MIGRATION` is not in the stock compose file; add it to the `smt` service's `environment:` if you need to change it.
