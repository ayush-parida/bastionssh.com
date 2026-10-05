---
title: Exec shells & recordings
section: docker
order: 30
summary: Open an interactive shell inside a running container from the browser, and find its recording afterwards.
keywords: [docker exec, container shell, bash, sh, terminal, recording, replay]
---

You can open an interactive shell inside a running container without logging in to the server first. It works like `docker exec -it <container> bash`, but runs over the server's SSH connection and appears in BastionSSH's normal terminal.

## Opening a shell

1. Go to **Servers → a server → Docker**.
2. Find a running container in the **Containers** tab, or click it to open its drawer.
3. Click **Open shell**.

The terminal page opens with the container's name in its header (hover it to see the container id and the server). The **Back to Docker** link returns you to the server's Docker page.

BastionSSH starts `/bin/bash` in the container. If the container has no bash (Alpine and other slim images often do not), it starts `/bin/sh` instead.

> **Note:** **Open shell** only shows for containers that are running. Start a stopped container first, from the same row.

### Who can open shells

| Role level on the server | Can open a shell |
| --- | --- |
| view | No |
| operate | Yes, while **Operators can open a shell in containers** is on (it is by default) |
| manage (admins, owners) | Always |

Members with the **manage** level on the Containers module (admins and owners by default) change this in the **Docker** section of **Settings**. Turning it off closes any container shells operators have open at that moment.

> **Warning:** A shell in a container runs as the container's default user, which is often root inside the container. Treat shell access like terminal access to the server.

## How the session behaves

A container shell is a terminal session like any other:

- It resizes with your browser window.
- If you close the browser tab, the session waits for about a minute in case you come back, then closes.
- When you close it, BastionSSH sends Ctrl+C and Ctrl+D so the shell exits instead of lingering in the container.
- It closes at once if your access to the server is revoked or expires, if you are demoted, or if the org stops letting operators open shells.

Files and the AI assistant are not available from a container shell's terminal page; they work on the server itself, not inside a container.

## Recordings

Container shells are recorded under the organisation's recording settings, just like server terminals. If recording is on (it is by default), the output is saved as an asciicast recording when the session ends.

To find a container shell recording:

1. Open **Recordings** in the sidebar.
2. Type part of the container's name (or id) in the **Container** filter.
3. Click a recording to replay it.

Container recordings are listed as **Shell in** *container name* with a container icon, so you can tell them apart from server terminals.

Who can see recordings, how long they are kept, and whether keystrokes are captured are covered in [Session recordings](/docs/monitoring/session-recordings).

## Auditing

Opening and closing a container shell are both recorded in the audit log against the server, naming the container. The closing entry includes the shell's exit code.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| **Open shell** is missing | The container is not running, or your role does not allow shells |
| The terminal shows an error right away | The container has neither `/bin/bash` nor `/bin/sh` (distroless images). Use logs instead |
| The session ends unexpectedly | Your access changed, or an admin turned off operator shells |

## Related

- [Terminal & sessions](/docs/servers/terminal-and-sessions)
- [Containers & actions](/docs/docker/containers-and-actions)
