---
title: FTP/SFTP connections
section: files
order: 20
summary: Connect to FTP, FTPS and SFTP-only accounts that are not full servers, with stored credentials, a start-directory jail and host key checks.
keywords: [ftp, ftps, sftp, shared hosting, cpanel, file transfer, host key, start directory, folder download, zip, tar.gz, archive]
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
- download a whole folder as one `.zip` or `.tar.gz` (see below);
- create a **New folder**, rename and delete files and whole folders.

Over SFTP, a recursive delete is refused if the tree is more than 64 levels deep or has more than 10,000 entries; this is checked before anything is removed.

## Downloading a folder

Click **Download folder** at the top to download the folder you are in, or the folder icon on a folder's row to download that one. The list next to **Download folder** picks the format, and your choice is remembered in this browser:

- **.zip** (default) opens with a double-click on macOS and Windows.
- **.tar.gz** also keeps symlinks and file permissions.

The archive is built on the BastionSSH server while it downloads; nothing is staged on disk on either side. A bar under the breadcrumbs shows how much has arrived, with **Cancel**. Cancelling, closing the page, or losing access to the connection stops the transfer on the remote server as well.

- **One file at a time.** The download uses a separate login of its own (you can keep browsing meanwhile) and reads one file at a time; over FTP, one data connection at a time.
- **The start-directory restriction applies to every file.** Over SFTP each folder and file is resolved on the server first; one that leads outside the start directory is left out and recorded as `ftp.path_refused`.
- **Symlinks are never followed.** A `.tar.gz` stores them as links; a `.zip` leaves them out with a note. Devices, sockets and pipes are left out.
- **Unreadable files don't stop the download.** A file the server refuses, or that vanished, is left out and listed in `_skipped.txt` at the top of the archive. If the connection drops part-way, BastionSSH logs in again and carries on with the next file.
- **Limits.** A download stops at `SMT_FOLDER_DOWNLOAD_MAX_BYTES` (10 GiB by default) or `SMT_FOLDER_DOWNLOAD_MAX_FILES` (100,000 files and folders); the archive then ends with `_TRUNCATED.txt`. Download the remaining subfolders separately.
- A folder download counts towards the eight live views and downloads each user can have open at once.
- Editing or deleting the connection (including its host key) ends downloads running on it.

Each folder download is audited as `ftp.folder_download` with the path, format, number of files, bytes, skipped entries, and whether it was truncated or cancelled.

> **Tip:** The browser keeps the archive in memory (or its own temporary storage) until it is complete. For very large folders, download subfolders one by one.

## Who can do what

| Level | Can |
| --- | --- |
| view | Browse and download files and folders |
| operate | Also upload, rename, create folders, delete files, and **Test** and **Diagnose** the connection |
| manage | Also add, edit and remove connections and manage the host key |

Each user gets one logged-in session per connection, reused across clicks and closed after two minutes idle. Every list, download, upload, rename, delete and configuration change is in the audit log.

## Timeouts and limits

| Limit | Default | Setting |
| --- | --- | --- |
| Largest upload | 1 GiB | `SMT_FTP_MAX_UPLOAD_BYTES` |
| Folder download size | 10 GiB | `SMT_FOLDER_DOWNLOAD_MAX_BYTES` |
| Files and folders in one folder download | 100,000 | `SMT_FOLDER_DOWNLOAD_MAX_FILES` |
| One SFTP request, or a stalled transfer | 30 seconds | `SMT_SFTP_OP_TIMEOUT_MS` |
| SFTP login (handshake and authentication) | 20 seconds, plus 10 s to open the file subsystem | fixed |
| FTP/FTPS socket with no traffic | 30 seconds | fixed |

An SFTP server that stops answering gets a timeout error and the session is closed, so the next click reconnects.

## When a connection fails

The card shows the last test result. For network problems, click **Diagnose** (or **Run diagnostics** next to the error) to walk DNS, TCP, TLS or the SSH banner, the host key and optionally a login. See [Diagnostics](/docs/servers/diagnostics).
