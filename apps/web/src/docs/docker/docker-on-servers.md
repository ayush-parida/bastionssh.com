---
title: Docker on servers
section: docker
order: 10
summary: How BastionSSH finds and talks to Docker over a server's SSH connection, what the server needs, and who can see what.
keywords: [docker, podman, rootless, docker socket, docker group, setup, permissions]
---

BastionSSH can show and manage the Docker containers, images, volumes and networks on any server you already manage. Nothing is installed on the server and no Docker port is opened: the app reaches the Docker socket through the server's own SSH connection.

## Opening a server's Docker page

1. Go to **Servers**.
2. On the server's card, click **Docker**.

The page shows the engine version (marked *rootless* when it is), the API version, disk usage, and tabs for **Containers**, **Images**, **Volumes**, **Networks** and **Compose**. Lists update live from the engine's event stream while the page is open.

## What the server needs

- Docker Engine (API version 1.25 or newer), rootless Docker, or Podman with its Docker-compatible socket.
- An SSH user that is allowed to use the Docker socket.
- sshd that either forwards Unix sockets, or a Docker CLI installed on the server (see below).

### How the connection works

BastionSSH tries, in order:

1. **Socket forwarding** — the Unix socket is forwarded over SSH. OpenSSH needs `AllowStreamLocalForwarding` and `AllowTcpForwarding` to allow it (both are on by default).
2. **`docker system dial-stdio`** — if sshd refuses socket forwarding, the app runs this command over an SSH exec channel instead. This needs the `docker` CLI on the server.

Host key checks, jump hosts and connectivity agents work exactly as they do for the terminal.

### Where Docker is looked for

On first use, BastionSSH looks for the socket at:

1. `/var/run/docker.sock` (the default);
2. rootless Docker under `$XDG_RUNTIME_DIR`;
3. Podman's Docker-compatible socket.

The result is remembered on the server. To change it, edit the server (**Servers → a server → Edit**). In the Docker part of the form you can:

- choose **Detect on use** (default) or **Off** to hide Docker for that server;
- enter a **Socket path** to use a specific socket instead of detecting;
- click **Detect Docker** to probe the server again now.

## Giving the SSH user access to the socket

The most common problem is that the SSH user is not allowed on the socket. The Docker page then says so and shows the fix, which you can copy:

```bash
sudo usermod -aG docker deploy
```

Replace `deploy` with your SSH user. Group changes only apply to new SSH logins, so click **Detect Docker** (or **Try again**) afterwards.

> **Warning:** Access to the Docker socket is root-equivalent on the server: anyone who can run containers can take the server over. The Docker page reminds you of this. Only give Docker access to users who should have root.

## When Docker cannot be reached

The tab explains why instead of showing an empty list:

| Problem | What it means | What to do |
| --- | --- | --- |
| Not installed | No `docker` command and no socket found | Install Docker Engine, or set the socket path |
| Daemon not running | The CLI exists but no socket answers | `sudo systemctl start docker`, or set the path for rootless Docker or Podman |
| Permission denied | The socket exists but the SSH user cannot use it | Add the user to the `docker` group (above) |
| Forwarding disabled | sshd refuses socket forwarding and there is no Docker CLI to fall back on | Allow `AllowStreamLocalForwarding yes` in `/etc/ssh/sshd_config` and reload sshd, or install the Docker CLI |
| Unsupported version | The engine is older than API 1.25 | Upgrade Docker |

**Diagnose** on a server with the login check ticked also checks Docker. See [Diagnostics](/docs/servers/diagnostics).

## Who can do what

Everyone who can access a server can list its containers, images, volumes and networks. Everything else depends on your level on that server:

| Capability | Needs |
| --- | --- |
| List containers, images, volumes, networks, Compose projects | view |
| Logs, live stats, `top`, environment and inspect output | operate |
| Start, stop, restart, pause, unpause, kill; pull images; Compose actions | operate |
| Open a shell in a container | manage, or operate when the org allows it (default on) |
| Remove containers and images | manage, or operate when the org allows it (default off) |
| Prune | manage, when the org allows it (default on) |
| Reveal environment values | manage, with a passkey confirmation |

Logs need the operate level because they routinely contain tokens and personal data.

### Org-wide Docker settings

Owners and admins set these under **Settings → Docker**:

- **Operators can open a shell in containers** (default on). Admins and owners always can.
- **Operators can remove containers and images** (default off).
- **Allow pruning** (default on).
- **Alert on unhealthy, crash-looping and failed containers** (default off). See [Containers fleet view & alerts](/docs/docker/containers-fleet-and-alerts).

Changes apply to the next action. Turning off shells for operators also closes operators' open container shells.

## Limits

- Each user may keep **8** live log, stats or event streams open at a time. Close a log view to open another.
- Log tails are capped at **10,000** lines.
- Revoking someone's access to a server, or suspending them, closes their Docker connections and streams immediately.

## Next steps

- [Containers & actions](/docs/docker/containers-and-actions)
- [Exec shells & recordings](/docs/docker/exec-shells-and-recordings)
- [Compose projects](/docs/docker/compose-projects)
