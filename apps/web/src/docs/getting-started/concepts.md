---
title: Concepts
section: getting-started
order: 30
summary: The handful of ideas everything else builds on — organizations, servers, credentials, roles, modules, access levels and the audit log.
keywords: [concepts, organization, roles, modules, access levels, audit, glossary]
---

A few ideas come up on almost every page of these docs. Read this once and the rest will make sense.

## Organization

Everything in BastionSSH — servers, keys, commands, clusters, members, settings — belongs to an **organization**. The first start creates one organization ("Default Organization") with you as its **owner**, and the app has no way to create another, so in practice an instance has one organization. The data model allows a person to belong to several; if they do, a switcher at the top of the sidebar lets them change which one they are working in, and nothing is shared between organizations.

## Servers and credentials

A **server** is an SSH endpoint: host, port, username and a way to log in — either one of the organization's **SSH keys** or a password. Credentials are encrypted at rest with the instance's vault key and never sent to the browser. A server can also have:

- **Tags** — free-form labels such as `prod` or `eu-west`, used for filtering, running commands on a group, and granting access by tag.
- A **jump host** or a **connectivity agent** — another route to servers that are not directly reachable.
- A pinned **host key** — the server's SSH identity, checked on every connection.

See [Adding servers](/docs/servers/adding-servers) and [Host keys](/docs/servers/host-keys).

## Roles

Every member has one **role**. Five are built in:

| Role | In short |
| --- | --- |
| **Owner** | Everything, plus owner-only actions such as giving the Owner role, database backups, single sign-on and sign-in policy. Cannot be edited. |
| **Admin** | Every module and every resource, at the highest level. |
| **Operator** | Uses every resource (terminals, commands, actions), plus the AI assistant and diagnostics. |
| **Viewer** | Sees every resource but does not change or connect to anything. |
| **No access** | Nothing beyond their own account. Useful as a base for members who get only specific grants. |

Admins can create **custom roles** too, and edit the built-in Admin, Operator and Viewer roles. See [Roles & modules](/docs/access/roles-and-modules).

## Modules

A **module** is a part of the app: Servers, Containers, Kubernetes, FTP, Object Storage, Saved Commands, Cron Jobs, Monitoring, Audit Log, Recordings, AI Assistant, Team & Access and so on. A role says, for each module, whether the member has it and at what level. A module the member does not have disappears from their sidebar, and its API refuses them.

## Access levels

Resources (servers, clusters, FTP connections, storage connections, saved commands, cron jobs, cloud accounts) are reached at one of three levels:

| Level | Means |
| --- | --- |
| **view** | See it and its status. |
| **operate** | Use it: open a terminal, run a command, browse and change files, run diagnostics. |
| **manage** | Change or delete it, and do admin-only things such as pinning host keys. |

A role's **resource grants** say which items a member reaches and at what level — all of them, specific items, everything with a tag, or (for clusters) particular namespaces. A member can also be given extra, possibly time-limited, access to single resources. See [Resource grants](/docs/access/resource-grants) and [Access requests & time-limited access](/docs/access/access-requests).

> **Note:** When a member's access is withdrawn — role changed, grant expired, member suspended — their open terminals, file sessions and live views on the affected resources are closed, not just future requests.

## Audit log

Almost everything that matters is written to the **audit log**: sign-ins (and failed ones), terminal connections, command runs, file changes, host key decisions, role and member changes, and settings changes. Each entry records who, what, when, from which IP, and the target. Admins read it under **Audit Log**; owners can set retention and forward it to a syslog server or webhook. See [Audit log](/docs/monitoring/audit-log).

## Recordings

Terminal sessions and one-shot command runs (saved commands, AI-run commands) are recorded by default so they can be replayed later. Owners decide whether recording is on, whether keystrokes are captured too, and how long recordings are kept. See [Session recordings](/docs/monitoring/session-recordings).

## Health checks and alerts

Every server is checked over SSH on a schedule — no agent on the server. Results feed the Dashboard, the Monitoring page and alerts that you can send to Slack, email, PagerDuty and many others. See [Health monitoring & alerts](/docs/monitoring/health-monitoring).

## The worker

Scheduled cron jobs and queued command runs are handled by a background **worker**. In the standard Docker Compose setup it runs inside the app process alongside a small Redis container that holds the queue. Without Redis (`SMT_REDIS_URL` unset), cron schedules are saved but do not fire on their own; see [Cron jobs](/docs/servers/cron-jobs).
