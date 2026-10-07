---
title: MySQL and MariaDB
section: deployments
order: 150
summary: Run MySQL 8.4 or 9, or MariaDB 11.8 or 11.4, on a server and connect from Node.js (mysql2, Prisma, Next.js), Python and Go; backups with mysqldump, restores and upgrades.
keywords: [mysql, mariadb, mysql2, prisma, pymysql, go-sql-driver, mysqldump, mariadb-dump, wordpress, laravel]
---

The MySQL template runs the official `mysql` image; the MariaDB template the official `mariadb` image. Both create one database, `app`, with a user `app`; both passwords — the app user's and root's — are generated on the server.

| | MySQL | MariaDB |
| --- | --- | --- |
| Versions | 8.4 LTS (default), 9 (innovation) | 11.8 LTS (default), 11.4 LTS |
| Port | 3306 | 3306 |
| `.env` | `MYSQL_USER=app`, `MYSQL_DATABASE=app`, `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD` | `MARIADB_USER=app`, `MARIADB_DATABASE=app`, `MARIADB_PASSWORD`, `MARIADB_ROOT_PASSWORD` |
| Data | `/var/lib/mysql`, exclusive | `/var/lib/mysql`, exclusive |
| Memory | 1g by default (at least 384m) | 512m by default |

## Connection strings

```
mysql://app:<password>@shop-db:3306/app
```

MariaDB speaks the MySQL protocol: every MySQL client and driver below connects to it unchanged.

## Node.js

With [mysql2](https://sidorares.github.io/node-mysql2/docs):

```js
import mysql from 'mysql2/promise';

const pool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 10 });
const [rows] = await pool.query('select now() as now');
```

In **Next.js**, create the pool once in a module (as for [PostgreSQL](services-postgres.md#nextjs)) and use it from Server Components, Route Handlers and Server Actions.

With **Prisma**: `provider = "mysql"` and `DATABASE_URL=mysql://app:<password>@shop-db:3306/app`; run `prisma migrate deploy` when the app starts, not while it builds (builds cannot reach the service).

## Python

```python
import os, pymysql
from urllib.parse import urlparse

u = urlparse(os.environ["DATABASE_URL"])
conn = pymysql.connect(host=u.hostname, port=u.port, user=u.username, password=u.password, database=u.path[1:])
```

SQLAlchemy takes `mysql+pymysql://app:<password>@shop-db:3306/app`.

## Go

With [go-sql-driver/mysql](https://github.com/go-sql-driver/mysql) (its own DSN form):

```go
db, err := sql.Open("mysql", "app:"+os.Getenv("DB_PASSWORD")+"@tcp(shop-db:3306)/app?parseTime=true")
```

## Backups and restore

**Back up now** runs `mysqldump` (`mariadb-dump`) as root with `--single-transaction --routines --triggers --events` for the `app` database: a consistent `.sql` file without locking InnoDB tables. **Restore** feeds the file to `mysql` (`mariadb`) as root: the dump recreates the database's tables. See [Backups](services-overview.md#backups).

On your own machine: `mysql -u root -p < shop-db-20261007T030000Z.sql`.

## Upgrading

**Update version** moves to the newest pinned release of the line (8.4.3 → 8.4.11, 11.8.2 → 11.8.9); the server upgrades its system tables on start.

Another line (MySQL 8.4 → 9, MariaDB 11.4 → 11.8) is refused in place: create a service of the new version and restore a backup into it, as described in [Upgrading](services-overview.md#upgrading). MySQL 9 is an *innovation* release, superseded every quarter; pick 8.4 for a database you mean to keep.

## Troubleshooting

- **The first start takes over a minute** — MySQL initialises its data folder on a server without networking first; the health check (over TCP, as root) waits up to three minutes.
- **`Access denied for user 'app'`** — the passwords are only read when the data folder is created. Changing `MYSQL_PASSWORD` later needs `ALTER USER 'app'@'%' IDENTIFIED BY '…'` too.
- **Killed with exit 137** — the memory limit: MySQL 8.4 needs about 400 MB idle. Raise `run.memory`.
