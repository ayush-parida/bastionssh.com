---
title: Other services
section: deployments
order: 200
summary: Memcached, Meilisearch, ClickHouse, Mailpit, Adminer, Grafana and Uptime Kuma from the catalog — what each template sets up, how to connect, backing them up and upgrading.
keywords: [memcached, meilisearch, clickhouse, mailpit, smtp, adminer, grafana, uptime kuma, monitoring, search, analytics]
---

These templates work like the databases (see [Quick services](services-overview.md)): created from **Deployments → New service**, reached by other apps at `<name>:<port>`, secrets generated on the server and shown on the Connection panel. Those with a web UI take a **domain** when you create them, served by the proxy with HTTPS.

## Memcached

`memcached:1.6-alpine` on port 11211: an in-memory cache, nothing on disk. Connect with `cache:11211` (`memjs` or `memcached` in Node.js, `pymemcache` in Python, `gomemcache` in Go).

> **Warning:** Memcached has no authentication: anything that reaches the port can read and change every key. Keep it unpublished; only apps on the server reach it then.

Its default cache is 64 MB; for more, add `-m 512` to a [`run.command`](bastion-yml.md#runcommand) (`["memcached", "-m", "512"]`) and raise `run.memory` above it.

## Meilisearch

`getmeili/meilisearch` on port 7700, in production mode, with `MEILI_MASTER_KEY` generated on the server. Give it a domain to search from browsers.

The master key is for administration only. Create a search-only key for browsers and an admin key for your backend with it:

```bash
curl -H "Authorization: Bearer <master key>" http://search:7700/keys
```

```js
import { MeiliSearch } from 'meilisearch';
const client = new MeiliSearch({ host: 'http://search:7700', apiKey: process.env.MEILI_ADMIN_KEY });
await client.index('products').addDocuments([{ id: 1, name: 'Book' }]);
```

Python: `meilisearch.Client("http://search:7700", key)`; Go: `meilisearch.New("http://search:7700", meilisearch.WithAPIKey(key))`.

Meilisearch reads only the database of its own minor version, so **Update version** stays within it (1.52.0 → 1.52.4). To move to a newer release, create a [dump](https://www.meilisearch.com/docs/learn/data_backup/dumps) with the API, create a new service of the newer version, and import the dump there.

## ClickHouse

`clickhouse/clickhouse-server` (25.8 LTS or 26.3 LTS) with a user `app`, a database `app` and `CLICKHOUSE_PASSWORD` generated on the server. HTTP on 8123, the native protocol on 9000.

```js
import { createClient } from '@clickhouse/client';
const ch = createClient({ url: 'http://events:8123', username: 'app', password: process.env.CLICKHOUSE_PASSWORD, database: 'app' });
await ch.query({ query: 'SELECT version()' });
```

Python: `clickhouse_connect.get_client(host="events", username="app", password=…)`; Go: `clickhouse.Open(&clickhouse.Options{Addr: []string{"events:9000"}, …})`.

ClickHouse wants memory: the template starts at 2g. Back it up with SQL — `BACKUP DATABASE app TO File('…')` with a backup disk configured, or `clickhouse-client --query "SELECT * FROM t FORMAT Native"` per table.

## Mailpit

`axllent/mailpit` catches every email your apps send and shows it in a web UI — for staging and development, never for real mail. Apps send to `smtp://mail:1025` (no TLS; any user name and password is accepted). The web UI is on 8025: give it a domain and sign in as `admin` with the generated `MAILPIT_UI_PASSWORD`.

```js
const transport = nodemailer.createTransport({ host: 'mail', port: 1025, secure: false });
```

## Adminer

`adminer` (5) is a one-page admin UI for PostgreSQL, MySQL, MariaDB and more. Give it a domain, open it, and log in with the **service name** as the server (`orders-db`) and its user and revealed password.

> **Warning:** Adminer shows a login form for every database on the server's private network to whoever opens its domain. Give it a domain only while you need it, and delete it afterwards — or keep it unpublished and reach it with an SSH tunnel.

## Grafana

`grafana/grafana` (13 or 12) with the user `admin` and `GF_SECURITY_ADMIN_PASSWORD` generated on the server; dashboards and settings are kept in its data volume. Give it a domain (its `GF_SERVER_ROOT_URL` is set to it), sign in, and add data sources by service name — PostgreSQL at `orders-db:5432`, ClickHouse at `http://events:8123`.

Grafana migrates its database forward on start, so **Update version** may move it to a new major; it cannot go back afterwards.

## Uptime Kuma

`louislam/uptime-kuma` (2) on port 3001: uptime checks, status pages and notifications, kept in its data volume. Give it a domain.

> **Warning:** The first visitor creates the admin account. Open it right after it is deployed and create the account yourself.

## Backups

Of these, none has a Backups tab — they keep little data, or have their own tools (Meilisearch dumps, ClickHouse `BACKUP`, Grafana's dashboard JSON). Their data volumes are `bastion-<name>.<volume>` on the server; a copy of a stopped service's volume is a complete backup:

```bash
docker run --rm -v bastion-dashboards.data:/data -v "$PWD":/out alpine tar czf /out/dashboards.tgz -C /data .
```

## Upgrading

**Update version** moves to the release the catalog pins for the service's line. Services whose data carries over between lines (Grafana, Mailpit, MinIO) may also change line; Meilisearch stays within its minor version, and Uptime Kuma and ClickHouse within their line. See [Upgrading](services-overview.md#upgrading).
