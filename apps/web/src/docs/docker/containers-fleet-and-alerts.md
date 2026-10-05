---
title: Containers fleet view & alerts
section: docker
order: 50
summary: Search containers across every server at once, and get alerted when a container is unhealthy, crash-looping or failed.
keywords: [containers, fleet, all servers, container alerts, unhealthy, restart loop, crash, notifications]
---

When you run Docker on more than a handful of servers, opening each server's Docker page gets slow. The **Containers** page lists containers from every server you can access in one table, and optional **container alerts** tell you when one goes wrong.

## The Containers page

Open **Containers** in the sidebar. You need the Containers module in your role (see [Roles & modules](/docs/access/roles-and-modules)).

The table shows each container's **Name**, **Server**, **Image**, **State**, **Status** and **Ports**. It only includes servers you have access to, and only those where Docker has been found.

- **Filter by name, image or project** in the search box.
- Filter by state (**Any state**, Running, Unhealthy, Restarting, Paused, Stopped), and pick one server from **All servers**.
- Stopped containers are included by default; untick **Show stopped** to see only running ones.
- Click a row to open that container on its server's Docker page, where you can read logs and run actions.

The list refreshes every minute while the page is open.

### Slow or unreachable servers

Servers are asked five at a time, with 10 seconds each. A server that is slow or down does not hold up the page: it is listed below the table under **One server did not answer** (or *N servers did not answer*) with the reason.

### Servers not checked yet

Docker is found on a server the first time someone opens its Docker page. Servers where nobody has done that yet are listed as **Not checked for Docker yet**, with a **Check them** button. Clicking it looks for Docker on those servers; the ones where it is found then appear in the table from then on.

## Container alerts

Container alerts are **off by default**, so a first rollout stays quiet. To turn them on:

1. Go to the **Docker** section of **Settings** (needs the **manage** level on the Containers module; admins and owners by default).
2. Turn on **Alert on unhealthy, crash-looping and failed containers**.

From then on, each regular health check also looks at the containers on servers where Docker was found, over the same SSH connection. Servers without Docker are never asked.

### What raises an alert

| Alert | When |
| --- | --- |
| Unhealthy | The container's healthcheck reports `unhealthy` |
| Restarting | The container restarted 3 or more times within 10 minutes |
| Exited | The container exited with an error while its restart policy says it should be running (anything other than `no`) |

A plain `docker stop` is not a failure and does not raise an **Exited** alert. Containers without a healthcheck never raise **Unhealthy**.

### How alerts are delivered

Container alerts go through the same notification channels as server health alerts (Slack, email, PagerDuty and so on), and resolve on their own when the container recovers. Each container gets its own alert, and its own incident in paging tools, so one flapping container does not hide another.

Set up channels first under **Settings → Alert notifications**. See [Notification channels](/docs/monitoring/notification-channels) and [Health monitoring & alerts](/docs/monitoring/health-monitoring).

> **Note:** Alerts depend on the health check. If monitoring is paused for a server, or turned off for the instance, its containers are not checked either.

## The AI assistant and containers

The AI assistant can also answer questions about containers. It can list containers, read the last lines of a container's logs (at most 500) and inspect a container, always with environment values hidden. Logs and inspect are only available to operators and above, as in the UI. Anything that would change a container must go through a command you approve. See [AI assistant](/docs/ai/ai-assistant).

## Related

- [Docker on servers](/docs/docker/docker-on-servers)
- [Containers & actions](/docs/docker/containers-and-actions)
