---
title: MongoDB
section: deployments
order: 160
summary: Run MongoDB 8.0 or 7.0 on a server and connect from Node.js (driver, Mongoose, Next.js), Python and Go; backups with mongodump, restores and upgrades.
keywords: [mongodb, mongo, mongoose, pymongo, mongo-driver, mongodump, mongorestore, authsource, kernel, 6.19]
---

The MongoDB template runs the official `mongo` image with authentication on: a root user `root` whose password is generated on the server.

| | |
| --- | --- |
| Versions | 8.0 (default), 7.0 — 7.0 on Linux kernels 6.19 and newer ([why](#linux-kernel-619-and-newer)) |
| Port | 27017 |
| `.env` | `MONGO_INITDB_ROOT_USERNAME=root`, `MONGO_INITDB_ROOT_PASSWORD` (generated) |
| Data | `/data/db` and `/data/configdb`, exclusive |
| Health check | `mongosh --eval 'db.adminCommand({ ping: 1 })'` |
| Memory | 1g by default |

## Connection strings

```
mongodb://root:<password>@events-db:27017/?authSource=admin
```

`authSource=admin` is needed: the root user is defined in the `admin` database. Pick your app's database in code (or add it before the `?`: `…:27017/shop?authSource=admin`).

> **Tip:** For an app, create a user with only its own database's rights (`db.createUser({ user: 'shop', pwd: '…', roles: [{ role: 'readWrite', db: 'shop' }] })` in `mongosh`) and connect with that instead of root.

## Node.js

```js
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);
const orders = client.db('shop').collection('orders');
```

With **Mongoose**: `await mongoose.connect(process.env.MONGODB_URI, { dbName: 'shop' })`.

In **Next.js**, connect once per server process (keep the client in a module, or on `globalThis` in development) and use it from Server Components, Route Handlers and Server Actions.

## Python

```python
import os
from pymongo import MongoClient

client = MongoClient(os.environ["MONGODB_URI"])
orders = client.shop.orders
```

## Go

```go
client, err := mongo.Connect(options.Client().ApplyURI(os.Getenv("MONGODB_URI")))
orders := client.Database("shop").Collection("orders")
```

## Backups and restore

**Back up now** runs `mongodump --archive --gzip` as root: every database in one compressed `.archive.gz` file. **Restore** runs `mongorestore --archive --gzip --drop`: each collection in the backup replaces the one on the server; collections the backup does not have are left alone. See [Backups](services-overview.md#backups).

On your own machine: `mongorestore --archive=events-db-20261007T030000Z.archive.gz --gzip --uri mongodb://localhost`.

## Upgrading

**Update version** moves to the newest pinned release of the line (8.0.12 → 8.0.32).

7.0 → 8.0 is refused in place: MongoDB needs its `featureCompatibilityVersion` raised one major at a time. Create an 8.0 service, restore a backup of the 7.0 one into it (`mongodump` archives restore into newer versions), and switch your apps over — see [Upgrading](services-overview.md#upgrading).

## Linux kernel 6.19 and newer

MongoDB 8 refuses to start on Linux kernels it reads as 6.19 or newer ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)) — including Ubuntu kernels that report `7.0.0-…` even when they carry the fix. On such a server BastionSSH offers MongoDB 8.0 greyed out, picks 7.0 for a new service, and refuses to deploy, update or roll back to 8.0 before anything is pulled. Check with `uname -r`; see [MongoDB 8 won't start on Linux kernel 6.19+](troubleshooting.md#mongodb-8-wont-start-on-linux-kernel-619) for the details and the fix.

## Troubleshooting

- **`Authentication failed`** — check `authSource=admin`, and that the password is the one revealed now: changing `MONGO_INITDB_ROOT_PASSWORD` after the first start does not change the user (use `db.changeUserPassword` in `mongosh`).
- **`MongoDB cannot start: Linux kernel versions 6.19 and newer has a known incompatibility`** — use 7.0 on this server: see [Linux kernel 6.19 and newer](#linux-kernel-619-and-newer).
- **High memory use** — MongoDB's cache takes about half of the container's memory limit: that is expected; lower or raise `run.memory` to taste.
