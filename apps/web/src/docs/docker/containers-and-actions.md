---
title: Containers & actions
section: docker
order: 20
summary: Inspect containers, read logs and live stats, start and stop them, pull images and prune unused resources.
keywords: [docker, containers, logs, stats, inspect, start, stop, restart, pull, prune, images, environment]
---

The **Containers** tab of a server's Docker page (**Servers → a server → Docker**) lists that server's containers with their state and health. This page covers what you can see and do with them. For setup and permissions, see [Docker on servers](/docs/docker/docker-on-servers).

## The containers list

- Stopped containers are included by default. Untick **Show stopped** to see only running ones.
- Use the **Filter by name, image or project** box to narrow the list.
- Each row shows the state (running, paused, exited…) and, when the container has a healthcheck, its health (healthy, unhealthy, starting).
- Action buttons on the right of each row depend on the container's state and your permissions.

The other tabs list **Images**, **Volumes** and **Networks**. Admins (or operators, if the org allows it) can remove an image from the **Images** tab.

## The container drawer

Click a container to open its drawer. It has these tabs:

| Tab | Shows | Needs |
| --- | --- | --- |
| **Overview** | State, created time, image, command, ports, Compose project and service, labels, and running processes | view (processes need operate) |
| **Logs** | The container's output | operate |
| **Stats** | Live CPU and memory (with charts), process count, network and block I/O, for a running container | operate |
| **Environment** | Environment variables, values hidden | operate |
| **Inspect** | The full `docker inspect` output, with environment values hidden | operate |

Tabs you cannot use are greyed out with the reason.

### Logs

- Choose how much history to load: 100, 500 (the default), 2,000 or 10,000 lines.
- **Follow** new lines as they arrive (on by default), or pause.
- Tick **Timestamps** to prefix each line with its time.
- **Search** shows only the lines that contain your text.
- **Download** saves the same logs as a text file.

### Hidden environment values

Environment values are shown as `KEY=••••` in the **Environment** and **Inspect** tabs, because they often hold passwords and API keys. On the **Environment** tab, an admin can click **Reveal values** to see them. This needs a passkey confirmation (an admin without a passkey must add one first, under **Settings → Passkeys**). The reveal is written to the audit log with the variable *names*, never the values.

## Container actions

Operators and above can control containers from the list or the drawer. The buttons offered depend on the state:

| State | Actions |
| --- | --- |
| Running | Open shell, Stop, Restart, Pause, Kill |
| Paused | Unpause, Kill |
| Restarting | Stop, Kill |
| Exited or created | Start |

**Stop**, **Restart**, **Kill** and **Remove** ask for confirmation first and name the container:

- **Stop** sends SIGTERM, then SIGKILL after the timeout.
- **Kill** sends SIGKILL at once, with no chance to shut down cleanly.
- **Remove** deletes the container and its writable layer. This cannot be undone. You can tick **Force: kill it first** for a running container and **Also remove its anonymous volumes**; named volumes are always kept.

Removing containers and images is for admins, unless an owner or admin turns on **Operators can remove containers and images** under **Settings → Docker**.

For **Open shell**, see [Exec shells & recordings](/docs/docker/exec-shells-and-recordings).

## Pulling images

1. Click **Pull image**, at the right of the tab bar on the server's Docker page.
2. Enter an image reference, for example `nginx:1.27` or `ghcr.io/org/app:tag`.
3. Watch the progress per layer.

The reference is checked against Docker's naming rules before anything runs. You can pull public images, or images from registries the server is already logged in to. Closing the dialog cancels the pull. Pulling needs the operate level.

## Pruning

**Prune…** removes things nothing uses any more. It is available to admins when **Allow pruning** is on under **Settings → Docker** (it is by default).

1. Click **Prune…**.
2. Choose what to clean up: stopped containers, images (dangling only, or tick the option for every unused image), unused volumes and unused networks. On most engines only anonymous volumes are pruned; the dialog says when named volumes would be included.
3. Review the dry run, which shows what would be removed and how much space it frees.
4. Confirm. The dialog then shows what was actually reclaimed.

> **Warning:** Choosing *all unused images* also removes tagged images that no container uses right now. The next start of such a container has to pull them again.

## Auditing

Every action, pull, prune and reveal is recorded in the audit log against the server, naming the container or image. Use **Audit Log** to see who stopped what and when.
