---
title: Resource grants
section: access
order: 20
summary: Give roles or single members access to specific servers, clusters, connections, commands and cron jobs at View, Operate or Manage.
keywords: [grants, resources, tags, namespaces, view, operate, manage, personal grant, all servers]
---

Modules decide which **features** a member may use. **Resource grants** decide which **items** they reach inside those features, and what they may do with each one. A grant always has a resource type, a selector and a level, and it can have an expiry.

## Resource types

| Type | Where you add it |
| --- | --- |
| Servers | Role editor → Resources → Servers |
| Kubernetes clusters | Role editor → Resources → Kubernetes clusters |
| FTP/SFTP connections | Role editor → Resources → FTP/SFTP connections |
| Object storage | Role editor → Resources → Object storage |
| Cloud accounts | Role editor → Resources → Cloud accounts |
| Saved commands | Role editor → Resources → Saved commands |
| Cron jobs | Role editor → Resources → Cron jobs |

Things that belong to a server follow the server: its terminal, files, Docker containers, health, host keys, diagnostics and recordings. Kubernetes views and actions follow the cluster (and namespace).

## Selectors: what a grant covers

Type in the **Add …** box of a resource section to pick one of:

- **A specific item** — for example `web-1`.
- **All of a type** — "All servers", "All clusters" and so on. It covers every item that exists now **and any added later**.
- **A tag** (servers only) — "Servers tagged `frontend`". Tags are checked live, so a server tagged `frontend` tomorrow is covered at once. The editor shows how many servers match right now.
- **Namespaces** (clusters only) — after adding a cluster, add namespace chips to narrow the grant to those namespaces. With no namespaces, the grant covers the whole cluster.

> **Warning:** Because tags can grant access, changing a server's tags needs **Manage** on that server and is recorded in the audit log. Tags a cloud provider reports for imported instances are shown as provider tags and **never** match a tag grant, so whoever controls tags in your cloud account cannot decide who reaches a server here.

## Levels

Each grant is **View**, **Operate** or **Manage**; each includes the ones before it.

| Type | View | Operate | Manage |
| --- | --- | --- | --- |
| Server | Status, health, metrics, Docker lists | Terminals, files, commands, Docker logs and actions, diagnostics with login | Edit, host keys, key rotation, Docker remove/prune/reveal, delete |
| Cluster | Map, workloads, events, diagnoses | Logs, YAML, scale, restart, delete pods, shells, Explain | Roll back, cordon, cluster settings and credentials |
| FTP/SFTP connection | Browse and download | Upload, rename, delete, test | Edit, host key, delete connection |
| Storage connection | List and download objects | Upload, rename, delete objects, test | Create and delete buckets, edit, delete connection |
| Cloud account | See it and its last sync | Sync now | Rename, regions, auto-import, delete (credentials stay admin-only) |
| Saved command | See it | Run it (also needs Operate on each target server) | Edit and delete |
| Cron job | See it and its runs | Run now, pause and resume | Edit and delete |

Organization-wide switches still apply on top of these levels. For example, if **Settings → Docker** does not let operators open shells in containers, Operate on a server does not include container shells; Manage always does.

## Add grants to a role

1. Open **Team & Access → Roles** and edit the role.
2. Under **Resources**, find the section (Servers, Kubernetes clusters, …).
3. Type in the **Add** box and pick an item, the "All …" entry, or (for servers) a tag.
4. Choose the level from the dropdown next to the entry. The dropdown explains each level, for example "Operate — terminals, files and commands".
5. Optionally set an expiry (**For 1 hour** … **For 7 days**) instead of **Permanent**.
6. For a cluster, add namespaces if the role should see only some of them.
7. Check the preview and click **Save changes**.

## Personal grants

Sometimes one person needs one extra server for an afternoon. Rather than creating a role, give them a **personal grant**:

1. Go to **Team & Access → Members**.
2. Click the access icon on the member's row (**Access: roles, personal grants and effective access**).
3. Under **Personal grants**, add the resources, levels and expiry exactly as in the role editor.
4. Click **Save personal grants**.

A personal grant counts only while one of the member's roles has the matching module on. For example, a server grant gives nothing to someone whose roles all have **Servers** set to None.

## When grants change

- Access checks happen on every request, so a new grant works immediately.
- Removing a grant, a role or a role membership closes what the member had open on resources they lost — terminals, file sessions, Docker and Kubernetes streams and shells, AI chats — at once.
- Grants with an expiry stop counting the moment they expire. Anything still open on them is closed within about a minute.
- No access to an item looks like it does not exist ("not found"). Having the item but too low a level gives a "forbidden" error.

To see the result of all of this for one person, use [Effective access and the access checker](/docs/access/effective-access).
