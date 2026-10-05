---
title: Audit log
section: monitoring
order: 40
summary: Search every recorded action, export it as CSV or JSON Lines, set how long it is kept, and forward it to syslog or a webhook.
keywords: [audit, log, export, csv, jsonl, retention, forwarding, syslog, webhook, siem, compliance]
---

The audit log records who did what and when: sign-ins, connections, commands, file transfers, configuration changes, access grants and more. Each event has the actor, the action (for example `server.create` or `user.login_failed`), the resource it touched, the time, the client IP and extra details.

## Reading the log

Open **Audit Log** in the sidebar. Filter with:

| Filter | Example |
| --- | --- |
| **From** / **To** | A date range |
| **Action** | `server.create`, or `user.*` for every action starting with `user.` |
| **Actor email** | The person who did it |

Click **Apply** to filter and **Clear** to reset. Use **Previous** / **Next** to page through results. Events that belong to a recorded terminal session have a play button that opens the recording.

> **Note:** Client IPs are only accurate when BastionSSH knows which reverse proxy to trust. Behind a proxy, set `SMT_TRUST_PROXY` (see [Installing & upgrading](/docs/operations/installing-and-upgrading)), or every event shows the proxy's IP.

## Exporting

The **CSV** and **JSON Lines** buttons at the top download every event that matches the current filters, oldest first. Exports are streamed, so large ranges work, and each export is itself recorded in the log.

In CSV, cells that start with `=`, `+`, `-` or `@` are prefixed with `'` so spreadsheet programs do not run them as formulas.

For scripts, use an API token (see [API tokens](/docs/security/api-tokens)):

```bash
curl -H "Authorization: Bearer $SMT_TOKEN" \
  "https://bastion.example.com/api/audit/export?format=jsonl&from=2026-01-01&action=user.*" \
  -o audit.jsonl
```

The export endpoint accepts `format` (`csv` or `jsonl`), `from`, `to`, `action`, `actorEmail`, `resourceType` and `resourceId`.

## Retention and forwarding (owners)

Below the log, owners see **Retention & forwarding**. Changing either needs a passkey confirmation when the owner has a passkey.

### Retention

**Keep events for** sets how long events are kept: 7 to 3650 days, default 365. A daily job deletes older events and records how many it removed as `audit.pruned`.

### Forwarding

Forwarding copies every new event, within about half a minute, to one target per organization. Use it to feed a SIEM or keep a copy outside BastionSSH.

**Syslog** (RFC 5424):

1. Next to **Forwarding**, click **Set up** (or **Edit**) and choose **Syslog**.
2. Enter the **Host**, **Protocol** (UDP, TCP or TLS), **Port** and **Facility**.
3. For TLS with a private certificate authority, paste a **CA certificate**. Public certificates are trusted already, and the collector's certificate is checked against the hostname you entered.

The event's key fields are sent as structured data (`[bastionssh@32473 org=… actor=… action=…]`) and the full event as JSON in the message. TCP and TLS use octet-counted framing (RFC 6587).

> **Warning:** UDP and TCP send events unencrypted. Use TLS unless the collector is on a trusted network.

**Webhook:**

1. Click **Set up** (or **Edit**) next to **Forwarding**, choose **Webhook** and enter an HTTPS URL.
2. Optionally set a **Signing secret**.

BastionSSH `POST`s batches as JSON:

```json
{ "source": "bastionssh", "events": [ { "action": "server.create", "actorEmail": "ana@example.com", "...": "..." } ] }
```

With a signing secret, each request carries `X-BastionSSH-Timestamp` and `X-BastionSSH-Signature: sha256=<HMAC-SHA256(secret, timestamp + "." + body)>`, so your receiver can check that the request is genuine and recent.

Click **Send test** to deliver one test event now and see whether the target accepted it.

### Delivery guarantees

Delivery is **at least once**. Each batch is tried up to three times; if every try fails, the target backs off (30 seconds, doubling up to 15 minutes). Nothing is skipped: the next attempt resumes where the last success stopped. Failures are shown on the page, and the first failure after a success is audited as `audit.forwarding_failed`. Targets and secrets are stored encrypted.

### Private networks

Targets must resolve to public addresses. Loopback, private, link-local and cloud-metadata addresses are refused, and the connection goes to the address that was checked. To forward to a collector on your own network, the instance operator lists the allowed ranges:

```bash
SMT_AUDIT_FORWARD_ALLOW_NETS=10.20.0.0/16,192.168.1.5
```

Metadata addresses stay refused regardless. Webhooks need HTTPS unless they point into such an allowed network.

## Who can do what

| Action | Audit Log module level | Default holders |
| --- | --- | --- |
| Read the log | view | Admins, owners |
| Export | operate | Admins, owners |
| See retention and forwarding | manage | Admins, owners |
| Change retention or forwarding, send a test | manage, and be an owner | Owners |

You can give a custom role read or export access without making someone an admin (see [Roles & modules](/docs/access/roles-and-modules)).
