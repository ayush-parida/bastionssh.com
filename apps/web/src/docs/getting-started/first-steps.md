---
title: First steps
section: getting-started
order: 20
summary: Sign in for the first time, add an SSH key and a server, and open a terminal in the browser.
keywords: [quick start, sign in, first login, admin password, add server, ssh key, terminal]
---

This page takes you from a freshly started instance to a working terminal on one of your servers in about five minutes. It assumes BastionSSH is already running; if not, start with [Installing & upgrading](/docs/operations/installing-and-upgrading).

## 1. Sign in as the first owner

On its very first start, BastionSSH creates one **owner** account for you.

- If you set `SMT_ADMIN_EMAIL` and `SMT_ADMIN_PASSWORD` before the first start, sign in with those.
- If you left `SMT_ADMIN_PASSWORD` unset, a random password was generated and printed **once** to the server log. With Docker Compose, find it with:

```bash
docker compose logs smt | grep "Generated a random admin password"
```

Open the instance in your browser (for example `http://localhost:8080`), enter the email and password on the **Sign in** page and click **Sign in**.

> **Warning:** Change the generated password straight away: **Settings → Account → Change password**. While you are there, consider adding a passkey under **Settings → Passkeys** — see [Passkeys & backup codes](/docs/security/passkeys-and-backup-codes).

There is no public sign-up page. Everyone else joins through an invite — see [Team & invites](/docs/access/team-and-invites).

## 2. Add an SSH key

BastionSSH logs in to servers with keys (or passwords) it stores encrypted. To add a key:

1. Open **SSH Keys** in the sidebar and click **Add key**.
2. Choose **Generate** to create a new key pair (Ed25519 is recommended; RSA 4096 and ECDSA P-256 are also offered), or **Import** to paste an existing private key or load it from a `.pem` file.
3. Give it a name and click **Generate** or **Import**.

When you generate a key, the private key is shown **once** so you can keep a copy; BastionSSH itself never shows it again. Copy the **public key** — you need it on the server.

> **Note:** Passphrase-protected private keys cannot be imported. Remove the passphrase first (`ssh-keygen -p -f key`) and import the result.

Put the public key on the server you want to manage, in the login user's `~/.ssh/authorized_keys`:

```bash
echo "ssh-ed25519 AAAA... my-bastion-key" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

## 3. Add a server

1. Open **Servers** and click **Add server**.
2. Fill in **Name** (anything you like), **Host** (IP address or DNS name), **Port** (usually `22`) and **Username**.
3. Under **Authentication**, keep **SSH Key** and pick the key from step 2 — or choose **Password** and type the server's SSH password.
4. Optionally add **Tags** such as `prod, web`. Tags let you filter the list, run a saved command on every matching server, and grant access by tag.
5. Click **Add**.

The server appears as a card. Within a minute or so its status dot shows whether the health check could reach it. Every other field in the form is explained in [Adding servers](/docs/servers/adding-servers).

## 4. Open a terminal

Click **Connect** on the server card. A full terminal opens in the browser; type as you would in any SSH client. The toolbar shows the connection state, a **REC** badge when the session is being recorded, **Files** to browse the server over SFTP, **AI** to open the assistant beside the terminal, and **Disconnect**.

The first connection to a new server pins its SSH host key (trust on first use). If you want to be strict, pin the fingerprint before connecting — see [Host keys](/docs/servers/host-keys).

## If the connection fails

When a connection times out or is refused, the error toast offers **Run diagnostics**. Diagnostics checks DNS, the TCP port, the SSH banner and the host key one by one, says which step failed, and suggests the firewall rule to add with BastionSSH's outbound IP. See [Diagnostics](/docs/servers/diagnostics).

Common first-time causes:

| Symptom | Likely cause |
| --- | --- |
| TCP connection filtered / timed out | A firewall or cloud security group does not allow BastionSSH's IP on port 22. |
| Authentication failed | The public key is not in `authorized_keys` for that user, or the password is wrong. |
| Host key verification failed | The server presented a different key than the one pinned. Review it before accepting. |

## What to do next

- Invite your team and decide who can do what: [Team & invites](/docs/access/team-and-invites) and [Roles & modules](/docs/access/roles-and-modules).
- Save commands you run often: [Saved commands](/docs/servers/saved-commands).
- Get alerts when a server goes down: [Health monitoring & alerts](/docs/monitoring/health-monitoring) and [Notification channels](/docs/monitoring/notification-channels).
- Serve the instance over HTTPS before your team relies on it: [Installing & upgrading](/docs/operations/installing-and-upgrading).
