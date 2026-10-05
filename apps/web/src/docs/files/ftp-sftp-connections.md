---
title: FTP/SFTP connections
section: files
order: 20
summary: Connect to FTP, FTPS and SFTP-only accounts that are not full servers, with stored credentials, a start-directory jail and host key checks.
keywords: [ftp, ftps, sftp, shared hosting, cpanel, file transfer, host key, start directory]
---

Some hosts only give you file access: shared hosting, cPanel accounts, SFTP-only (chrooted) users, or old appliances. The **FTP** module lets you register these as *connections* and browse them from the browser, without adding them as servers.

## Adding a connection

Adding, editing and removing connections needs the **manage** level on the FTP module (admins by default).

1. Open **FTP** in the sidebar.
2. Click **Add connection**.
3. Fill in the form:
   - **Name** — anything that helps you recognise it, for example "Marketing site (cPanel)".
   - **Protocol** — see the table below. The port fills in to match.
   - **Host**, **Port** and **Username**.
   - **Authentication** (SFTP only) — **Password** or an **SSH key**.
   - **Start directory** (optional) — for example `/public_html`. Blank opens the account's login directory.
   - **Verify TLS certificate** (FTPS only) — untick for a host with a self-signed certificate.
   - **Restrict to the start directory** — on by default for new connections.
4. Click **Add**, then **Test** on the connection's card to check it works.

The password is encrypted at rest with the same vault as SSH keys. It is never sent back to the browser; when editing, leave it blank to keep the existing one.

### Protocols

| Protocol | Default port | When to use |
| --- | --- | --- |
| FTPS (explicit TLS) | 21 | The safe default. Connects on the FTP port and upgrades to TLS before logging in. Most hosts support it. |
| FTPS (implicit TLS) | 990 | TLS from the first byte. Older FileZilla Server and IIS setups use this. |
| SFTP (SSH File Transfer) | 22 | File transfer over SSH, with a password or one of your SSH keys. Works with SFTP-only accounts that have no shell. |
| FTP (no encryption) | 21 | Credentials and files travel in the clear. Only on a trusted network. Its card is marked **FTP · no TLS**. |

## Key authentication (SFTP)

For SFTP you can log in with one of the organisation's SSH keys instead of a password. Choose **SSH key** under **Authentication** and pick a key from the list (manage keys under **SSH Keys**).

- Choosing a key (or changing the host, user or start directory of a key-based connection) also needs the **operate** level on **SSH Keys**.
- A retired key (for example, one replaced by key rotation) cannot be chosen and is refused.
- A key that a connection still uses cannot be deleted until you switch the connection to another key.

## Restricting to the start directory

With **Restrict to the start directory** ticked, every path must stay inside the start directory (or the login directory when no start directory is set). Anything outside is refused and recorded in the audit log as `ftp.path_refused`.

- **SFTP:** symlinks are resolved on the server before each operation, so a link that leads out of the directory is refused too.
- **FTP/FTPS:** the protocol cannot tell where a symlink leads, so paths are only checked by name.

> **Note:** This restriction controls what BastionSSH lets people reach. It is not a replacement for a proper chroot on the server; someone who can also change links on the server could race it.

## Host keys (SFTP)

SFTP connections check the server's host key, just like managed servers. The connection card shows the host key status and fingerprint. The buttons below need the **manage** level on the connection.

- **Trust on first use:** with no key pinned, the first connection trusts the key the host presents and pins it.
- **Scan & pin** reads the key the host presents now and asks you to confirm it before pinning.
- **Pin…** lets you paste a known fingerprint (`SHA256:` followed by 43 base64 characters) before anyone connects. This is the safest option.
- **Forget host key** (trash icon) removes the pin; the next connection trusts whatever key it sees.

If the host later presents a different key, connections are refused until an admin reviews it. The card shows **Different key presented** with both fingerprints and an **Accept new key…** button. Only accept after confirming with the host's owner that the key really changed. See [Host keys](/docs/servers/host-keys) for the general idea.

## Browsing files

Click **Browse** on a connection. You can:

- open folders, go up a level or use the breadcrumbs;
- **Upload** files (or drag them onto the page) — uploads are streamed;
- download a file by clicking it or the download icon;
- create a **New folder**, rename and delete files and whole folders.

Over SFTP, a recursive delete is refused if the tree is more than 64 levels deep or has more than 10,000 entries; this is checked before anything is removed.

## Who can do what

| Level | Can |
| --- | --- |
| view | Browse and download |
| operate | Also upload, rename, create folders, delete files, and **Test** and **Diagnose** the connection |
| manage | Also add, edit and remove connections and manage the host key |

Each user gets one logged-in session per connection, reused across clicks and closed after two minutes idle. Every list, download, upload, rename, delete and configuration change is in the audit log.

## Timeouts and limits

| Limit | Default | Setting |
| --- | --- | --- |
| Largest upload | 1 GiB | `SMT_FTP_MAX_UPLOAD_BYTES` |
| One SFTP request, or a stalled transfer | 30 seconds | `SMT_SFTP_OP_TIMEOUT_MS` |
| SFTP login (handshake and authentication) | 20 seconds, plus 10 s to open the file subsystem | fixed |
| FTP/FTPS socket with no traffic | 30 seconds | fixed |

An SFTP server that stops answering gets a timeout error and the session is closed, so the next click reconnects.

## When a connection fails

The card shows the last test result. For network problems, click **Diagnose** (or **Run diagnostics** next to the error) to walk DNS, TCP, TLS or the SSH banner, the host key and optionally a login. See [Diagnostics](/docs/servers/diagnostics).
