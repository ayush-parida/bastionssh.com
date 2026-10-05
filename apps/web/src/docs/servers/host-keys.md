---
title: Host keys
section: servers
order: 30
summary: How BastionSSH pins each server's SSH host key, how to pin one in advance, and what to do when a server presents a different key.
keywords: [host key, fingerprint, tofu, trust on first use, pin, mismatch, man in the middle, known_hosts]
---

Every SSH server has a **host key** that proves its identity — the same thing your own SSH client stores in `~/.ssh/known_hosts`. BastionSSH remembers ("pins") one host key per server and checks it on **every** connection: terminals, saved commands, cron jobs, the file browser, health checks, Docker and diagnostics. If a server suddenly presents a different key, BastionSSH refuses to connect before sending any password or key.

## The three states

Each server card shows a host key badge:

| Badge | Meaning |
| --- | --- |
| **Host key unknown** | Nothing pinned yet. The next connection will trust whatever key the host presents and remember it. |
| **Host key trusted** | A key is pinned; connections are only made when the host presents it. |
| **Host key changed** | The host presented a different key. Every connection is refused until an admin reviews it. |

Click the badge to open the **host key panel** on the server's **Health** page (**Servers → a server → Health**). Everyone who can see the server sees the status and fingerprint; pinning, accepting and forgetting keys need the *manage* level on that server (admins by default).

Fingerprints use the OpenSSH format, `SHA256:` followed by 43 base64 characters, so they compare directly with what `ssh-keygen -lf` prints.

## Trust on first use

If you add a server without a fingerprint, the first connection of any kind pins the key it sees. This is convenient and is how most SSH clients behave, but that very first connection is not protected: if someone were intercepting it, their key would be pinned. The audit log records it as `server.host_key_trusted` with method `tofu`, and the panel says **Trusted on first connection**.

## Pinning a key in advance

To close that gap, pin the real fingerprint before anyone connects. On the server, run:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

It prints something like `256 SHA256:Xb3…kQ root@web-1 (ED25519)`. Then either:

- paste the `SHA256:…` part into **Host key fingerprint** in the server form when adding or editing it, or
- open the host key panel and click **Scan & pin**. BastionSSH connects, shows the fingerprint and key type the server offers, and asks you to compare it with the output above. Click **It matches — pin it** only if it does.

> **Warning:** A scan cannot tell a real server from an impostor — it only shows what answered. Always compare the scanned fingerprint with one you read on the server itself (console, cloud provider's serial log, or an existing trusted session).

If the server uses a different key type, use the matching file, such as `ssh_host_ecdsa_key.pub` or `ssh_host_rsa_key.pub`.

> **Note:** Changing a server's **Host** or **Port** forgets the pinned key, because it says nothing about a new endpoint. Enter the new endpoint's fingerprint in the same edit to stay pinned.

## When the key changes

A changed key has two common explanations:

1. **Expected** — the server was rebuilt or reinstalled, its SSH keys were regenerated, or the IP address now belongs to a different machine.
2. **Not expected** — something between BastionSSH and the server is intercepting the connection (a man-in-the-middle).

When it happens:

- The connection is refused before any credentials are sent. Terminals show **SSH host key verification failed** with the expected and presented fingerprints and a **Review the host key →** link.
- The server's badge turns red (**Host key changed**).
- The event is audited as `server.host_key_mismatch`.
- An alert opens and is sent to your notification channels. To avoid floods from a host flapping between keys, notifications are sent at most once an hour per server and presented key; the alert, the audit log and the mismatch shown in the UI still follow every change.

### Accepting a new key

Only do this when you know why the key changed.

1. Open the host key panel (click the red badge, or **Review the host key →**).
2. Read the presented fingerprint in the red box.
3. Check it on the server itself with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.
4. If they match, click **Accept new key…** and confirm.

The new key is pinned, connections work again, the alert resolves, and the decision is audited as `server.host_key_accepted`.

If you cannot explain the change, do **not** accept it. Leave the server refused and investigate — check with whoever runs the network and the server.

## Forgetting a key

**Forget key** removes the pinned key, so the next connection trusts whatever it sees (trust on first use again). It is audited as `server.host_key_forgotten`. Prefer **Accept new key…** or **Scan & pin** so you stay in control of what is trusted.

## Jump hosts and agents

- Behind a **jump host**, each hop's key is checked against that hop's own pinned key, and the target's key is checked end to end through the tunnel.
- Behind a **connectivity agent**, the agent only carries bytes; the host key check still runs between BastionSSH and the server. Because a compromised agent could answer a first connection itself, pin the fingerprint up front for servers behind agents.

## SFTP connections

Connections under **FTP** that use SFTP follow the same rules, with their own pinned key. See [FTP/SFTP connections](/docs/files/ftp-sftp-connections).
