---
title: PostgreSQL
section: deployments
order: 140
summary: Run PostgreSQL 16, 17 or 18 on a server and connect from Node.js (pg, Prisma, Drizzle, Next.js), Python and Go; backups with pg_dump, restores, and moving to a new major version.
keywords: [postgres, postgresql, pg, prisma, drizzle, psycopg, pgx, database_url, pg_dump, pg_restore, migrate]
---

The PostgreSQL template runs the official `postgres` image (Alpine variant) with one database, `app`, owned by the user `app`, whose password is generated on the server as `POSTGRES_PASSWORD`. Data lives in the Docker volume `bastion-<name>.data`; it stays when the container is replaced, and goes only when the service is deleted with its data.

| | |
| --- | --- |
| Versions | 18, 17 (default), 16 — Alpine images pinned by digest |
| Port | 5432 |
| `.env` | `POSTGRES_USER=app`, `POSTGRES_DB=app`, `POSTGRES_PASSWORD` (generated, 24 random bytes) |
| Data | `/var/lib/postgresql/data` (`/var/lib/postgresql` for 18), exclusive |
| Health check | `pg_isready -h 127.0.0.1` inside the container |
| Memory | 512m by default |

## Connection strings

From apps on the same server (the Connection panel fills in the password after a reveal):

```
postgres://app:<password>@orders-db:5432/app
```

Most libraries read it from `DATABASE_URL`. Add it to your app's **Environment** and restart the app.

## Node.js

With [`pg`](https://node-postgres.com):

```js
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const { rows } = await pool.query('select now()');
```

### Next.js

Create the pool once per server process — in a module, not inside a route handler — so a busy app does not open a connection per request:

```ts
// lib/db.ts
import pg from 'pg';

const globalForPg = globalThis as unknown as { pool?: pg.Pool };
export const pool = globalForPg.pool ?? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
if (process.env.NODE_ENV !== 'production') globalForPg.pool = pool;
```

Use it from Server Components, Route Handlers and Server Actions only; the database is not reachable from the browser. A **static export** has no server: it cannot query a database at all.

### Prisma

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

with `DATABASE_URL=postgresql://app:<password>@orders-db:5432/app?schema=public`.

Run migrations when the app **starts**, not while its image is built: builds run outside the server's private network and cannot reach `orders-db`. For example, in the Dockerfile's command:

```dockerfile
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
```

or once by hand from a shell on the server: `bastionctl exec my-app -- npx prisma migrate deploy`.

### Drizzle

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
export const db = drizzle(process.env.DATABASE_URL!);
```

## Python

With [psycopg](https://www.psycopg.org) 3:

```python
import os, psycopg

with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
    print(conn.execute("select now()").fetchone())
```

SQLAlchemy and Django take the same URL (`postgresql+psycopg://…` for SQLAlchemy; `dj-database-url` for Django).

## Go

With [pgx](https://github.com/jackc/pgx):

```go
pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
if err != nil { log.Fatal(err) }
defer pool.Close()
var now time.Time
err = pool.QueryRow(ctx, "select now()").Scan(&now)
```

## Backups and restore

**Back up now** runs `pg_dump -Fc` (the custom format: compressed, restorable table by table) inside the container; files end in `.dump`. **Restore** runs `pg_restore --clean --if-exists --no-owner --single-transaction`: it drops and recreates every object the backup has, all in one transaction, so a restore that fails changes nothing. See [Backups](services-overview.md#backups).

On your own machine, a downloaded backup restores into any PostgreSQL of the same or a newer major version:

```bash
pg_restore --no-owner -d postgres://localhost/mycopy orders-db-20261007T030000Z.dump
pg_restore --list orders-db-20261007T030000Z.dump   # what it holds
```

## Upgrading

**Update version** moves to the newest pinned release of the service's major version (17.4 → 17.11): minor releases share the data format and need nothing else.

A new **major** version (16 → 17) changes the data files, so it is refused in place. Move with a dump: back up the old service, create one of the new version, copy the backup into its `backups/` folder on the server and restore it there, then point your apps at it. `pg_restore` of a newer major reads dumps of older ones. See [Upgrading](services-overview.md#upgrading).

## Troubleshooting

- **`password authentication failed for user "app"`** — the app's `DATABASE_URL` has another password than the service's `.env`. Reveal it again on the Connection panel. Changing `POSTGRES_PASSWORD` in the service's Environment does **not** change the password of an existing database (it is only read when the data folder is first created); change it with `ALTER USER app PASSWORD '…'` and then the `.env`.
- **`could not translate host name "orders-db"`** — the app is not on this server, or not deployed by Deployments (only app containers join `bastion-apps`).
- **The first start takes long** — `initdb` writes the data folder before the server listens; the health check waits up to two minutes.
- **`FATAL: sorry, too many clients already`** — 100 connections by default: lower your pools' sizes, or add `-c max_connections=200` as a [`run.command`](bastion-yml.md#runcommand) (`["postgres", "-c", "max_connections=200"]`) and restart.
