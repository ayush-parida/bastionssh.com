---
title: Adding servers
section: servers
order: 10
summary: Every field of the server form — key or password login, tags, jump hosts, connectivity agents and host key pinning — plus managing and rotating SSH keys.
keywords: [add server, ssh key, password, jump host, bastion, agent, tags, key rotation, generate key, import key]
---

A server in BastionSSH is an SSH endpoint plus the credentials to log in to it. This page covers the SSH keys you log in with, the server form field by field, and the two ways to reach servers that are not directly reachable: jump hosts and connectivity agents.

## SSH keys

Keys live under **SSH Keys** in the sidebar and belong to the organization, so several servers can share one.

### Generate or import a key

1. Click **Add key**.
2. Pick **Generate** or **Import**:
   - **Generate** creates a new key pair: **Ed25519 (recommended)**, **RSA 4096** or **ECDSA P-256**. The private key is shown once for you to copy; BastionSSH never shows it again.
   - **Import** takes an existing private key — paste it, or use **Import .pem file**. The key is checked the same way it will be used at connect time, so an unusable key is refused straight away.
3. Name it and confirm.

> **Note:** Passphrase-protected keys are not supported. Remove the passphrase first with `ssh-keygen -p -f <keyfile>`.

The table lists each key's type, fingerprint, creation date and how many servers use it. Keys older than 180 days are flagged so you remember to rotate them.

### Deleting a key

A key cannot be deleted while it is the login key of a server or of an SFTP connection; the error names them. Switch those to another key first.

### Rotating a key

Admins can **Rotate** a key — on a single server card, on several servers at once (tick the checkboxes on their cards, then **Rotate keys**), or for every server using a key from the **SSH Keys** page. A rotation:

1. generates a new key,
2. adds it to the server's `~/.ssh/authorized_keys` (keeping the old line's options),
3. proves it can log in with the new key,
4. switches the server over and removes the old key.

If any step fails, it rolls back and the server keeps its old key. A key still used elsewhere (another server, a cloud account or an SFTP connection) is left in place; otherwise the old key is **retired** and refused from then on. Rotation needs a passkey confirmation when the admin has a passkey, and each step is kept in the rotation history (the clock icon on the **SSH Keys** page) and the audit log.

## The server form

Open **Servers → Add server**, or **Edit** on an existing card. Adding servers needs the *manage* level on the Servers module (admins by default).

| Field | What to enter |
| --- | --- |
| **Name** | Any label; shown on cards, in the terminal and in the audit log. |
| **Host** | IP address or DNS name. Behind an agent this is only a label (see below). |
| **Port** | The SSH port, usually `22`. |
| **Username** | The account to log in as. Defaults to `root`; a normal user with `sudo` is usually better. |
| **Authentication** | **SSH Key** with a key from the list, or **Password**. Passwords are stored encrypted and never shown again; leave the field blank when editing to keep the current one. |
| **Connect via** | **Direct connection** or a connectivity agent. |
| **Tags** | Comma-separated, e.g. `prod, web, eu-west`. Used for filtering, saved-command fan-out and role tag selectors. |
| **Jump host** | Another server to go through, like `ssh -J`. |
| **Host key fingerprint** | Optional. Pin the server's key up front instead of trusting it on first connect. |
| **Docker** | Admins only: detect Docker automatically, set a socket path, or turn it off for this server. |

When editing, changing **Host**, **Port**, **Username** or the jump host needs *manage* on Servers. Changing the host or port also forgets the pinned host key unless you enter the new fingerprint at the same time.

## Jump hosts

Pick another server of the organization as **Jump host** to reach this one through it, exactly like `ssh -J`. Chains of up to **three hops** work (a jump host can itself have a jump host), and the form does not offer choices that would create a loop.

- Each hop connects with **its own** credentials and its own host key check; the target's host key is still verified end to end.
- Every kind of connection uses the chain: terminals, commands, cron jobs, the file browser, health checks, host key scans and diagnostics.
- Members using the server do not need access to the jump host. Each hop is audited as `server.jump`.
- Setting a jump host needs *operate* access to the jump server.
- When a hop fails, only people who can access that jump server see which host failed and why. Everyone else sees "The route to this server failed at hop N", counted from BastionSSH outwards.
- Deleting a jump host makes the servers behind it connect directly.

## Connectivity agents

For servers with no SSH port reachable from BastionSSH, an admin installs a small agent on a machine in that network (see [Connectivity agents](/docs/operations/connectivity-agents)). Then in the server form:

1. Set **Connect via** to the agent.
2. Set **Port** to the SSH port as seen from the agent's own host. The agent only ever connects to `127.0.0.1` on that port, so the **Host** field is just a label.
3. Make sure the port is on the agent's allowlist (`BASTION_ALLOWED_PORTS`, default `22`).

> **Warning:** The agent is treated as untrusted transport: host keys are still checked end to end. Pin the server's fingerprint in the form when you can, so a compromised agent cannot introduce a fake host on first use.

A server uses either a jump host or an agent, not both — the form disables one while the other is set. (A jump host may itself sit behind an agent.) If an agent is revoked, its servers fail closed rather than connecting directly.

## Server cards

Each card shows the address, a status dot from the latest health check, the host key status, route badges (`via <jump host>` or the agent name), the key's age, cloud badges for imported instances, tags, and a timer when your access to it is time-limited. Buttons depend on your access level: **Connect** and **Files** need *operate*; **Edit** and delete need *manage*; **Health** and the access list are there for anyone who can see the server.

Restricted members also see **Request access** to ask for servers they cannot use — see [Access requests & time-limited access](/docs/access/access-requests).

## Related

- [Host keys](/docs/servers/host-keys)
- [Terminal & sessions](/docs/servers/terminal-and-sessions)
- [Cloud accounts](/docs/operations/cloud-accounts) — import servers instead of adding them by hand.
