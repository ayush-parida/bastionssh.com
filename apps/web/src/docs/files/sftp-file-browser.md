---
title: SFTP file browser
section: files
order: 10
summary: Browse, edit, upload and download files (or whole folders) on any managed server over its existing SSH connection.
keywords: [sftp, files, upload, download, editor, file manager, server files, folder download, zip, tar.gz, archive]
---

Every server you manage has a built-in file browser. It uses SFTP over the same SSH connection, credentials and host key check as the terminal, so there is nothing extra to install or configure on the server.

## Opening the file browser

1. Go to **Servers**.
2. On the server's card, click **Files**.

The browser opens in the SSH user's home directory. The page header shows which account and host you are browsing (for example `SFTP on deploy@10.0.0.12`).

> **Note:** The file browser needs the **operate** level on the server, for reading as well as writing. Someone who can only *view* a server sees it in the list but cannot open its files. See [Resource grants](/docs/access/resource-grants).

## Moving around

- Click a folder name to open it. A symlink that points to a folder opens like a folder.
- Use the breadcrumb path above the table to jump back to any parent folder, or **/** for the root.
- The up-arrow button goes up one level.
- **Refresh** (the circular arrow) reloads the current folder.

The table shows each entry's **Name**, **Size**, **Permissions** (for example `rwxr-xr-x`) and **Modified** time.

## Working with files

| Action | How | Notes |
| --- | --- | --- |
| Download | Download icon on a file's row | Streams the file to your browser. |
| Download a folder | Folder-download icon on a folder's row, or **Download folder** for the folder you are in | One `.zip` or `.tar.gz` of everything inside. See [Downloading a folder](#downloading-a-folder). |
| View or edit | Click a file's name, or the edit icon | Opens an inline text editor. |
| Upload | **Upload** button, or drag files onto the page | Several files can be chosen at once; each goes into the current folder. A file with the same name is replaced without asking. |
| New folder | **New folder** | Asks for a name. |
| Rename | Pencil icon | Renames within the current folder. |
| Delete | Trash icon | Asks for confirmation (see below). |

### The inline editor

Clicking a file opens it in a full-screen editor. Make your changes and click **Save** (or press **Ctrl+S** / **Cmd+S**). An *unsaved* marker shows while you have pending changes, and closing asks before discarding them.

- Files up to **2 MiB** can be opened in the editor. Larger files are refused with a message to download them instead, and a file that looks binary (a null byte near the start) is refused too.
- The editor is plain text. Use it for config files, scripts and logs, not binaries.
- Saving writes the whole file back to the server.

### Downloading a folder

Click the folder-download icon on a folder's row, or **Download folder** at the top to take the folder you are in. Choose a format, then **Download**:

| Format | Best for |
| --- | --- |
| `.zip` (default) | Opening with a double-click on macOS and Windows. Symbolic links cannot be stored and are left out. |
| `.tar.gz` | Linux and backups: symbolic links stay links, permissions are kept. |

The archive is built on the fly while it downloads; nothing is staged on the server or on BastionSSH. The dialog shows how much has arrived so far (the total is not known until it ends) and **Cancel download** stops the work on the server too. In Chrome and Edge you choose where to save first and the archive goes straight to that file; other browsers hold it in memory until it is complete, and the dialog offers the browser's own download instead for very large folders.

How it is built:

- **`.tar.gz` from an account with a shell** runs `tar` on the server over the same SSH connection, which is much faster for folders with many small files. BastionSSH checks what `tar` sends member by member (the same rules as below) and re-compresses it, so the archive you get follows the same rules either way. A folder whose path holds a backslash or a line break is always read over SFTP.
- **`.zip`, and `.tar.gz` from an SFTP-only account** (for example `ForceCommand internal-sftp` or a `nologin` shell), are built by BastionSSH reading one file at a time over SFTP.

BastionSSH checks once per connection whether the account can run `tar` and `gzip`, and uses SFTP whenever it cannot, so you do not need to choose.

What is in the archive:

- Paths are relative to the folder you chose; nothing in the archive can extract outside it (no absolute names, no `..`, nothing stored under a symbolic link, no hard link to a file that is not in the archive). Symbolic links are never followed. Devices, sockets and pipes are left out, and setuid / setgid bits are dropped.
- Files that cannot be read (permission denied, deleted while downloading) are left out and listed in **`_skipped.txt`** at the top of the archive; the download carries on. For a `.tar.gz` made by `tar` on the server, the list is what `tar` reported.
- If a limit is reached (see [Limits](#limits)), the archive ends cleanly with **`_TRUNCATED.txt`** saying where it stopped. Download the remaining subfolders separately.

If the connection breaks part-way, the dialog says so and nothing is saved: an archive cut short cannot be opened.

### Deleting folders

When you delete a folder you are asked twice: first to confirm the delete, then whether to delete its contents recursively. Choose **Cancel** on the second prompt to delete only if the folder is already empty. A recursive delete cannot be undone.

> **Warning:** Everything you do here runs as the server's SSH user. If that user can delete `/etc`, so can the file browser. Use an SSH user with only the rights it needs.

## Limits

| Limit | Default | Setting |
| --- | --- | --- |
| Largest upload | 1 GiB | `SMT_SFTP_MAX_UPLOAD_BYTES` |
| Largest file in the editor | 2 MiB | fixed |
| Largest folder download (bytes of file content) | 10 GiB | `SMT_FOLDER_DOWNLOAD_MAX_BYTES` |
| Most files and folders in one folder download | 100 000 | `SMT_FOLDER_DOWNLOAD_MAX_FILES` |

Uploads are streamed straight through to the server, so large files are not held in memory. The SFTP connection is kept open between clicks and closed after 5 minutes without activity.

A folder download holds one of your live streams while it runs (the same allowance as Docker log and stats views, 8 at a time); one more is refused with *Too many downloads and live views open* until one finishes.

## Host keys, jump hosts and agents

The file browser connects exactly like the terminal:

- The server's host key is checked against the pinned one. If the server presents a different key, the browser shows the mismatch and a way to review it instead of connecting. See [Host keys](/docs/servers/host-keys).
- Servers behind a jump host or a connectivity agent work the same way. See [Adding servers](/docs/servers/adding-servers).

## Auditing and access changes

Every listing, download, upload, new folder, rename and delete is written to the audit log against the server, with the path. A folder download is recorded once it ends, as `sftp.folder_download`, with the format, how it was built (`tar` or `sftp`), the number of files and bytes, what was skipped (and the first lines `tar` reported), whether it was truncated or cancelled, and how long it took. If your access to the server is revoked or expires, your open file sessions on it are closed, and a folder download in progress stops.

## Related

- [FTP/SFTP connections](/docs/files/ftp-sftp-connections) for SFTP-only accounts and FTP hosts that are not managed servers
- [Terminal & sessions](/docs/servers/terminal-and-sessions)
