---
title: RabbitMQ
section: deployments
order: 190
summary: Run RabbitMQ 4 with its management UI on a domain, and publish and consume from Node.js (amqplib), Python (pika) and Go.
keywords: [rabbitmq, amqp, queue, amqplib, pika, amqp091, management, broker]
---

The RabbitMQ template runs the official `rabbitmq:4-management` image (Alpine): the broker and its management UI, with a user `app` whose password is generated on the server.

| | |
| --- | --- |
| Ports | 5672 (AMQP), 15672 (management UI) |
| `.env` | `RABBITMQ_DEFAULT_USER=app`, `RABBITMQ_DEFAULT_PASS` (generated), `RABBITMQ_NODENAME=rabbit@localhost` |
| Data | `/var/lib/rabbitmq`, exclusive |
| Domain | for the management UI (optional) |
| Memory | 512m by default |

The node name is fixed to `rabbit@localhost`: RabbitMQ keeps its data in a folder named after the node, and a new container would otherwise get a new host name — and start empty.

## Connection strings

```
amqp://app:<password>@queue:5672/
```

The trailing `/` is the default virtual host. Publishing exposes the AMQP port; the management UI is meant for a domain.

## Node.js

```js
import amqp from 'amqplib';

const conn = await amqp.connect(process.env.AMQP_URL);
const ch = await conn.createChannel();
await ch.assertQueue('jobs', { durable: true });
ch.sendToQueue('jobs', Buffer.from(JSON.stringify({ id: 1 })), { persistent: true });
```

In **Next.js**, publish from Route Handlers or Server Actions through one connection per server process; run consumers in a separate app (a worker with its own Dockerfile and no domains) rather than in the web app.

## Python

```python
import os, pika

conn = pika.BlockingConnection(pika.URLParameters(os.environ["AMQP_URL"]))
ch = conn.channel()
ch.queue_declare(queue="jobs", durable=True)
ch.basic_publish(exchange="", routing_key="jobs", body=b'{"id": 1}')
```

## Go

```go
conn, err := amqp.Dial(os.Getenv("AMQP_URL")) // github.com/rabbitmq/amqp091-go
ch, err := conn.Channel()
```

## Backups

There is no Backups tab: queues are transient by design. Export the **definitions** (exchanges, queues, users, policies) from the management UI (**Overview → Export definitions**) or with `bastionctl exec queue -- rabbitmqctl export_definitions /tmp/defs.json`.

## Upgrading

**Update version** moves within RabbitMQ 4 (4.1 → 4.3). Before a move to a new major, enable all feature flags (**Admin → Feature Flags**) as RabbitMQ's upgrade guide says, then create a new service and recreate the definitions there.

## Troubleshooting

- **The health check takes long** — `rabbitmq-diagnostics ping` needs the Erlang node up; the first start takes 20–40 seconds.
- **`ACCESS_REFUSED`** — the user and password are created on the first start only; change them in the management UI afterwards.
