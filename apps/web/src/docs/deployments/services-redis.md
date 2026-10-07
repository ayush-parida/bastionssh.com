---
title: Redis and Valkey
section: deployments
order: 170
summary: Run Redis 8 or 7.4, or Valkey 9 or 8, with a generated password, and connect from Node.js (node-redis, ioredis, Next.js), Python and Go; RDB backups, restores and upgrades.
keywords: [redis, valkey, cache, sessions, queue, bullmq, ioredis, node-redis, redis-py, go-redis, rdb, requirepass]
---

The Redis template runs the official `redis` image (Alpine), the Valkey template `valkey/valkey` — the Linux Foundation's open-source fork, compatible with every Redis client. Both require a password, generated on the server, and snapshot their data to disk every minute when something changed.

| | Redis | Valkey |
| --- | --- | --- |
| Versions | 8 (default), 7.4 | 9 (default), 8 |
| Port | 6379 | 6379 |
| `.env` | `REDIS_PASSWORD` (generated) | `VALKEY_PASSWORD` (generated) |
| Data | `/data` (`dump.rdb`), exclusive | `/data` (`dump.rdb`), exclusive |
| Memory | 256m by default | 256m by default |

The server starts with `--requirepass "$REDIS_PASSWORD" --appendonly no --save 60 1`: an RDB snapshot every minute after a change, and on every clean stop — a restart or Update version keeps the data.

## Connection strings

```
redis://default:<password>@cache:6379/0
```

## Node.js

With [node-redis](https://github.com/redis/node-redis):

```js
import { createClient } from 'redis';

const redis = await createClient({ url: process.env.REDIS_URL }).connect();
await redis.set('greeting', 'hello', { EX: 60 });
```

With [ioredis](https://github.com/redis/ioredis) (and BullMQ, which uses it): `new Redis(process.env.REDIS_URL)`.

In **Next.js**, connect once per server process — keep the client in a module — and use it from Server Components, Route Handlers and Server Actions.

## Python

```python
import os, redis

r = redis.Redis.from_url(os.environ["REDIS_URL"])
r.set("greeting", "hello", ex=60)
```

## Go

```go
opt, err := redis.ParseURL(os.Getenv("REDIS_URL"))
rdb := redis.NewClient(opt)
err = rdb.Set(ctx, "greeting", "hello", time.Minute).Err()
```

## Backups and restore

**Back up now** takes an RDB snapshot with `redis-cli --rdb` (`valkey-cli`) inside the container; files end in `.rdb`. **Restore** stops the container, puts the file in place of `/data/dump.rdb` and starts it again: the cache is unavailable for a few seconds and comes back with exactly the backup's keys. See [Backups](services-overview.md#backups).

A Redis RDB file loads into the same or a newer Redis (or Valkey) version.

## Upgrading

**Update version** moves to the newest pinned release of the line (8.0 → 8.10): the server is stopped (saving its snapshot), and the new one starts and loads it.

Another major (7.4 → 8, Valkey 8 → 9) is refused in place, as for databases: create a service of the new version and restore a backup into it — see [Upgrading](services-overview.md#upgrading). Redis 8 is distributed under the AGPLv3 (or Redis's own licences); Valkey stays BSD-licensed.

## Troubleshooting

- **`NOAUTH Authentication required` / `WRONGPASS`** — the URL needs the password, as the user `default`. Changing the password: set it in the service's Environment and **Restart** (the server reads it at start).
- **`OOM command not allowed`** — the memory limit is reached. Raise `run.memory`, or make it a pure cache with `--maxmemory-policy allkeys-lru` added to [`run.command`](bastion-yml.md#runcommand).
