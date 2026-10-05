---
title: Effective access and the access checker
section: access
order: 50
summary: See exactly what a member can use and reach, and why — per member, per resource, or for one member on one resource.
keywords: [effective access, access checker, who has access, why, audit access, explain, permissions]
---

With several roles, personal grants, tags and expiries in play, "why can Alice open a terminal on web-1?" deserves a direct answer. BastionSSH gives you three views that read the same access rules the server enforces:

| View | Answers | Where |
| --- | --- | --- |
| **Effective access** | Everything one member can use and reach, and why | Team & Access → Members → access icon |
| **Access checker** | One member on one resource: which level, and every reason | Team & Access → Access checker |
| **Who has access** | Everyone who reaches one resource, and through what | The people icon on a server, cluster, connection, cloud account, saved command or cron job |

All three need the **Roles & access** module at View or higher.

## Effective access for a member

1. Go to **Team & Access → Members**.
2. Click the access icon on the member's row (**Access: roles, personal grants and effective access**).
3. Scroll to **Effective access** — "What they can use and reach right now, at which level, and why."

The section has two parts.

### Modules

Every module the member has, with their level and a badge for each role that gives it, for example **Servers · Operate**, "via Web team · operate", "via Viewer · view". When several roles give a module, the highest level wins and all of them are listed, highest first.

A module marked **hidden — nothing in it for them** is turned on by a role but has no item the member can see (and they cannot create one), so it does not appear in their sidebar.

"None — only their own account" means the member effectively has **No access**.

### Resources

Under headings such as **Servers** and **Kubernetes clusters**, every item the member reaches, with:

- the **level** (View, Operate or Manage),
- for clusters, the **namespaces** they are limited to,
- one badge per reason, for example:
  - "via Web team, tag: frontend" — a role covering servers tagged `frontend`,
  - "via Operator, all of this type" — a role covering every server,
  - "personal, expires in 3h" — a time-limited personal grant.

"No resources — they cannot see any server, cluster or connection" means none of their roles or grants covers anything.

The same dialog lets people with **Roles & access** at Manage change the member's roles and personal grants, so you can fix what you find in place. Members cannot change their own access.

## The access checker

Use the checker when the question is about one person and one thing.

1. Go to **Team & Access → Access checker**.
2. Pick the **Member**.
3. Pick the **Type** (Servers, Kubernetes clusters, FTP/SFTP connections, Object storage, Cloud accounts, Saved commands or Cron jobs).
4. Pick the **Resource**.
5. For a cluster, optionally type a **Namespace** to check that namespace rather than the cluster as a whole.

The answer shows the member's level on that resource and lists every reason, each with its own level:

```text
Alice on web-1: Operate
  • Operate — via Web team, tag: frontend
  • View — via Viewer, all of this type
```

"No role or personal grant covers it" means they cannot reach it at all — to them it does not exist.

## Who has access to a resource

On the Servers, Kubernetes cluster, FTP, Object Storage, Cloud Accounts, Saved Commands and Cron Jobs pages, people with **Roles & access** see a people icon (**Who has access**) on each item. It opens a list of every active member who reaches the item, their level and the reasons, in the same badge format. Use it before deleting a role or retiring a server to see who would be affected.

## Reading the results

- **The highest level wins.** A member with View from one role and Operate from another has Operate.
- **Modules gate grants.** A grant only counts while one of the member's roles turns on the matching module. If effective access shows a resource missing that a grant should cover, check the role's module levels (look for **parked** in the role editor).
- **Tags are live.** A tag grant covers whatever carries the tag right now; retagging a server changes who reaches it.
- **Expiry is shown and enforced.** A badge reading "expired" no longer counts; it disappears at the next sweep (within about a minute).
- **Organization switches still apply.** The checker shows the level; settings such as "operators may open shells" under **Settings → Docker** or **Settings → Kubernetes** may still turn off individual actions at Operate.
- **Owners** reach everything, always, at Manage.

Checking access is not recorded in the audit log; changing it is. See [Roles and modules](/docs/access/roles-and-modules) and [Resource grants](/docs/access/resource-grants) to change what you find.
