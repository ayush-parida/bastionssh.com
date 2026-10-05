---
title: Terminal & sessions
section: servers
order: 20
summary: How the in-browser terminal works — opening and closing sessions, what the toolbar does, recording, and what happens when access is withdrawn.
keywords: [terminal, ssh session, xterm, connect, disconnect, recording, rec, websocket]
---

Clicking **Connect** on a server card opens a real interactive SSH shell in your browser. BastionSSH holds the SSH connection on its side and streams the terminal to your browser over a WebSocket, so your machine never sees the server's credentials.

## Who can open a terminal

You need the **Servers** module and the *operate* level on that server — Operators, Admins and Owners by default, or anyone a custom role or personal grant gives *operate* on it. Viewers see the server but have no **Connect** button.

The server needs a way to log in: a key or a password in its settings. A server with neither is refused with "No authentication method configured for this server", and a server whose key has been **retired** by a key rotation is refused until it is given another key.

## Opening a session

1. Go to **Servers**.
2. Click **Connect** on the server card.
3. The terminal page opens. The status next to the server name moves from **Connecting…** to **Connected**.

Each connection is written to the audit log as `server.connect`, with a link to its recording when recording is on.

If the connection cannot be made — a timeout, a refused port, a DNS failure — the error toast offers **Run diagnostics**, which walks through the connection step by step. See [Diagnostics](/docs/servers/diagnostics). If the server presented a different host key than the pinned one, the page says **SSH host key verification failed** and links to the host key panel; no credentials were sent. See [Host keys](/docs/servers/host-keys).

## The toolbar

| Control | What it does |
| --- | --- |
| Back arrow | Returns to **Servers** and closes the session. |
| Server name and `user@host:port` | Which server you are on. |
| Status | **Connecting…**, **Connected** or **Disconnected**. |
| **REC** | Shown when the session is recorded. A keyboard icon next to it means keystrokes are recorded too. |
| **Files** | Opens the server's SFTP file browser. See [SFTP file browser](/docs/files/sftp-file-browser). |
| **AI** | Opens the AI assistant beside the terminal. It can see the last part of the terminal's output to help explain errors. See [AI assistant](/docs/ai/ai-assistant). |
| **Diagnose** | Appears after a session drops, to check why. |
| **Disconnect** | Closes the SSH session. |

The terminal resizes with the browser window; BastionSSH passes the new size to the server so full-screen programs such as `htop`, `vim` and `less` draw correctly.

## How sessions end

A session ends when:

- you click **Disconnect** or the back arrow;
- the shell exits (for example you type `exit`) — the terminal shows **[Session closed]**;
- the browser goes away without saying so (closed laptop, lost network): BastionSSH keeps the SSH session for **one minute** with nothing attached and then closes it;
- your access is withdrawn (see below).

There is no automatic reconnect. After a session has ended, click **Connect** again for a new one. Long-running work should be started inside `tmux` or `screen` on the server if it must survive a dropped browser.

## Recording

By default every terminal session is recorded in asciicast format — the output you saw, with timing — so it can be replayed later under **Recordings**. Owners decide on the **Recordings** page whether recording is on, whether keystrokes are captured as well (off by default), and how long recordings are kept (90 days by default).

> **Warning:** When keystroke recording is on, everything you type is captured, including passwords typed at `sudo` or login prompts. The terminal shows a warning and the **REC** badge carries a keyboard icon so you know.

See [Session recordings](/docs/monitoring/session-recordings) for playback, search and retention.

## When access is withdrawn

Sessions do not outlive the access that opened them. A member's open terminals on a server are closed when:

- they are suspended or removed from the organization;
- their role changes so they no longer have *operate* on the server;
- a time-limited grant expires (closed within a minute of expiry);
- an admin signs them out everywhere or resets their password.

The terminal then shows the session as closed. Reloading the page cannot re-attach to a session the member is no longer allowed to use.

## Shells inside containers and pods

The same terminal page is used for shells inside Docker containers and Kubernetes pods. Those have their own rules and are covered in [Exec shells & recordings](/docs/docker/exec-shells-and-recordings) and [Logs & pod shells](/docs/kubernetes/logs-and-pod-shells).

## Tips

- Prefer a normal user with `sudo` over `root` as the server's username; `sudo` prompts still work in the browser terminal.
- To run the same command on many servers, use [Saved commands](/docs/servers/saved-commands) instead of opening a terminal on each.
- To schedule something, use [Cron jobs](/docs/servers/cron-jobs) rather than leaving a terminal open.
