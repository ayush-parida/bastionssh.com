---
title: Health monitoring & alerts
section: monitoring
order: 10
summary: How BastionSSH checks every server over SSH, what it measures, and when it opens and resolves alerts.
keywords: [monitoring, health, alerts, cpu, memory, disk, load, offline, thresholds, acknowledge]
---

BastionSSH checks the health of your servers on its own, without installing anything on them. Every minute (by default) it opens a short SSH connection to each server, runs one read-only probe, and stores the result. You see live status on the **Dashboard**, in the **Servers** list and on the **Monitoring** page, and you get alerts when something goes wrong.

## What is measured

The probe reads standard system files and commands, so it works on any normal Linux host:

| Metric | Where it comes from |
| --- | --- |
| Reachability and SSH response time | The SSH handshake itself |
| Uptime | `/proc/uptime` |
| Load average | `/proc/loadavg`, compared per CPU core |
| CPU usage | `/proc/stat`, the difference between two checks |
| Memory and swap | `/proc/meminfo` |
| Disk usage | `df -Pk`, every real filesystem |
| Processes and logged-in users | `ps -e` and `who` |
| OS and kernel | `/etc/os-release` and `uname` |

Hosts without `/proc` (macOS, BSD) still report what they can, such as reachability, disks and the process count, rather than failing.

The check uses the server's own connection settings: its SSH key or password, its pinned host key, and any jump host or agent route. If the host key no longer matches, the check stops and raises a host key alert instead of connecting (see [Host keys](/docs/servers/host-keys)).

## Where to look

- **Monitoring** in the sidebar shows a card per server with CPU, memory and disk bars, a 3-hour CPU trend, and tiles counting servers that are **Online**, **Offline**, have **Check errors**, and the number of **Active alerts**.
- Click a server's name to open its health page (**Servers → a server → Health**). It shows the latest values, a **Filesystems** table, and **History** charts for CPU, memory, load, disk and SSH response time over 1 hour, 6 hours, 24 hours or 7 days.
- **Check now** (the refresh icon) runs a check immediately instead of waiting for the next sweep.

## Alerts

After each check BastionSSH decides which problems are present and compares them with the alerts already open for that server.

| Alert | Opens when | Severity |
| --- | --- | --- |
| Offline | The server failed this many checks in a row (default 2) | Critical |
| CPU high | CPU is at or above 90% | Warning, critical when halfway to 100% |
| Memory high | Memory is at or above 90% | Warning, critical when halfway to 100% |
| Disk high | Any real filesystem is at or above 90% full | Warning, critical when halfway to 100% |
| Load high | 1-minute load per core is at or above 2 | Warning, critical at 15% above the threshold |
| Host key mismatch | The server presented a different SSH host key | Critical |

An alert **resolves by itself** when the condition clears. A host key mismatch is the exception: it stays open until an admin accepts, pins or forgets the key, even if the server goes back to the old key, because someone should look at it.

Other parts of BastionSSH raise alerts through the same system when you turn them on: container alerts (see [Containers fleet view & alerts](/docs/docker/containers-fleet-and-alerts)), Kubernetes cluster alerts, and certificate alerts for deployed apps (see [Deployments](/docs/deployments/overview)).

### Acknowledging

On the **Monitoring** page, **Active alerts** lists every open alert with its severity and how long it has been open. **Acknowledge** marks an alert as seen and records who did it. It does not close the alert; it still resolves when the problem goes away. Acknowledging is recorded in the audit log.

### Getting notified

Alerts always appear in the app. To also receive them in Slack, email, PagerDuty and so on, add a channel under **Settings → Alert notifications**. See [Notification channels](/docs/monitoring/notification-channels).

## Pausing checks for a server

On a server's health page, **Pause checks** stops monitoring that server (its status shows as paused) and closes its open alerts without notifying anyone; **Resume checks** turns it back on. Use this for machines that are often off on purpose.

Servers imported from a cloud account are skipped automatically while the provider reports them **stopped** or **missing**, so they do not raise offline alerts. See [Cloud accounts](/docs/operations/cloud-accounts).

## Who can do what

| Action | Needs |
| --- | --- |
| See a server's health page | Access to the server |
| See the **Monitoring** page and alerts | Monitoring & Alerts at **view**; only servers you can access are shown |
| Check now | **operate** on that server |
| Acknowledge an alert | **operate** on that server and Monitoring & Alerts at **operate** (every built-in role has it) |
| Pause or resume checks | **manage** on that server |
| Manage notification channels | Monitoring & Alerts at **manage** (admins and owners by default) |

## Tuning (operators of the instance)

Thresholds and timing are set with environment variables on the BastionSSH container and apply to every server. Defaults are shown:

```bash
SMT_MONITORING_ENABLED=true          # false turns health checks off entirely
SMT_MONITORING_INTERVAL=60           # seconds between sweeps (minimum 15)
SMT_MONITORING_CONCURRENCY=5         # servers checked in parallel
SMT_MONITORING_TIMEOUT=20000         # per-check timeout in ms
SMT_MONITORING_RETENTION_HOURS=168   # how long samples are kept (7 days)
SMT_ALERT_CPU_PERCENT=90
SMT_ALERT_MEMORY_PERCENT=90
SMT_ALERT_DISK_PERCENT=90
SMT_ALERT_LOAD_PER_CORE=2
SMT_ALERT_OFFLINE_FAILURES=2         # failed checks in a row before "offline"
```

> **Note:** There is no per-server threshold. If one server is always busy, pause its checks or raise the threshold for the whole instance.

> **Note:** If a sweep takes longer than the interval (a large or slow fleet), the next one is skipped rather than piling up. Raise `SMT_MONITORING_CONCURRENCY` or the interval if you see "Previous health sweep still running" in the logs.
