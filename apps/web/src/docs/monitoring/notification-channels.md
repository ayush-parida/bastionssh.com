---
title: Notification channels
section: monitoring
order: 20
summary: Send alerts to Slack, Teams, Discord, PagerDuty, Opsgenie, email, webhooks and more, filtered by severity.
keywords: [notifications, alerts, slack, discord, teams, pagerduty, opsgenie, email, smtp, webhook, ntfy, telegram]
---

Alerts always show in the app. A **notification channel** also sends them somewhere your team will see them: a chat room, a pager, an inbox or your own webhook. Channels belong to the organization, and every alert in the organization goes to every enabled channel that accepts its severity.

## Add a channel

1. Open **Settings** and scroll to **Alert notifications**.
2. Click **Add channel**.
3. Give it a **Name** (for example `#ops-alerts`) and pick a **Type**.
4. Fill in the fields that type needs (see the table below). Secrets are stored encrypted and are not shown again.
5. Choose **Send when**: **Warning and above** or **Critical only**.
6. Tick **Notify when resolved** if you also want a message when the problem clears.
7. Click **Save**, then use the paper-plane icon (**Send test notification**) to check it arrives.

Each channel in the list shows a masked target, its filter, and the result of its last delivery (**Last delivery OK** or **Last delivery failed:** with the reason). Use **Disable** to pause a channel without deleting it, the pencil icon to edit it (leave credential fields blank to keep the stored ones), and the bin icon to remove it.

## Channel types

| Channel | What you need |
| --- | --- |
| Slack / Mattermost | An incoming-webhook URL |
| Discord | A channel webhook URL (Channel settings → Integrations → Webhooks) |
| Microsoft Teams | A Workflows webhook URL (posts an Adaptive Card) |
| Google Chat | A space webhook URL |
| Telegram | A bot token from @BotFather and the chat id |
| PagerDuty | An Events API v2 integration key; incidents open with the alert and resolve when it clears |
| Opsgenie | An API integration key and region (US or EU); alerts are created and closed by alias |
| ntfy | The topic URL; use `user:password@host` for a protected server |
| Gotify | Your server's `/message?token=…` URL |
| Pushover | An application token and your user key |
| Email | SMTP configured on the instance; up to 20 recipients per channel |
| Webhook | Any HTTP(S) endpoint; receives a structured JSON body. `user:password@` in the URL becomes HTTP Basic auth |

For PagerDuty and Opsgenie, each alert gets its own incident, so a server that is down and a disk that is full page separately and resolve separately.

> **Note:** A URL with `user:password@` in it is split into a clean URL plus an `Authorization: Basic` header before sending. This is how ntfy, Gotify behind a proxy and many internal webhooks are protected.

## Email needs SMTP

The **Email** type is greyed out ("SMTP not configured") until the instance has an SMTP server. Set both variables on the BastionSSH container and restart it:

```bash
SMT_SMTP_URL=smtp://user:password@smtp.example.com:587   # or smtps://…:465
SMT_SMTP_FROM="BastionSSH <alerts@example.com>"
```

`SMT_SMTP_FROM` is required whenever `SMT_SMTP_URL` is set; the server refuses to start otherwise. The same SMTP settings are used for account notices such as new-device sign-ins and passkey changes.

## What gets sent

A channel receives a message when an alert **opens**, and, with **Notify when resolved**, when it **resolves**. That covers:

- server health alerts (offline, CPU, memory, disk, load) — see [Health monitoring & alerts](/docs/monitoring/health-monitoring)
- SSH host key mismatches on servers and SFTP connections
- container alerts, when turned on under **Settings → Docker**
- Kubernetes cluster alerts, when turned on under **Settings → Kubernetes**
- certificate alerts for deployed apps — see [Deployments](/docs/deployments/overview)

A changed host key is notified at most once an hour per server and presented key, so a host flapping between keys does not flood your channels. The alert in the app and the audit log still record every change.

## Delivery and failures

Each delivery has a 10-second timeout and is retried once after a short pause. If it still fails, the error is shown on the channel ("Last delivery failed: …") and in the server log; the alert itself is unaffected. There is no queue of missed notifications, so fix a broken channel and use **Send test notification** to confirm.

> **Warning:** Webhook URLs pointing at the cloud metadata address (`169.254.169.254`, `metadata.google.internal`) are refused. Other private addresses are allowed, so internal tools on your network work.

## Who can manage channels

Seeing the list needs the **Monitoring & Alerts** module at **view**. Adding, editing, testing and removing channels needs **manage**, which admins and owners have by default. You can give it to others with a custom role (see [Roles & modules](/docs/access/roles-and-modules)).
