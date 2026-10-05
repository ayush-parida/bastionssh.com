---
title: AI command approval
section: security
order: 50
summary: The AI assistant runs read-only commands on its own, but any command that could change a server waits for you to approve it.
keywords: [ai, approval, approve, deny, run_command, command safety, read-only, assistant, audit]
---

The [AI assistant](/docs/ai/ai-assistant) can run shell commands on your servers to investigate problems. To keep that safe, every command it wants to run is classified first:

- **Read-only commands run immediately** — `df -h`, `uptime`, `systemctl status nginx`, `journalctl -u app --since today`, and so on.
- **Anything that could change a server waits for you** — restarts, installs, edits, deletes, writes to files, `sudo`, and anything not recognised as read-only. You see an approval card and must click **Approve** before it runs.

You do not need to switch anything on; approval is always part of the assistant.

## The approval card

When the assistant wants to make a change, an **Approval needed** card appears in the chat — on the **AI Assistant** page or in the AI panel next to a terminal. It shows:

| Part | Meaning |
| --- | --- |
| The command | Exactly what will run, in full. |
| `user@server` | The SSH user it runs as and the server it runs on. |
| Host key badge | **host key trusted** (pinned), **host key not yet pinned** (the key will be trusted on first use), or **host key changed** (the connection will be refused until an admin reviews it). See [Host keys](/docs/servers/host-keys). |
| Reason | Why it needs approval, for example "runs a command with elevated privileges" or "Uses command substitution, which runs another command". |

Then:

1. Read the command carefully. Check the server and user are the ones you expect.
2. Click **Approve** to run it, or **Deny** to refuse.
3. The card changes to **approved**, **denied** or **expired**, and the assistant continues.

If you deny a command, or it expires, the assistant is told not to retry it or a variation of it; it should explain what it wanted to do and ask how you want to proceed.

## Timeouts and cancelling

- A command waits up to **5 minutes** for a decision. After that it is treated as denied and marked **expired**.
- Stopping the chat, closing the panel or losing the connection cancels anything still waiting; it is never run later.
- If your access changes while you chat (a role is removed, you are suspended, the server is taken away), the conversation is stopped with "Your access has changed".

## Who can approve

Only **you** — the person chatting — can approve your assistant's commands. Pending approvals are tied to your user and organization; nobody else can see or settle them, not even an admin.

Approval never widens access. To run anything on a server, including read-only commands, you need **Operate** on that server, exactly as for opening a terminal. If you only have View on a server, the assistant cannot run commands there at all. See [Resource grants](/docs/access/resource-grants).

## How commands are classified

The classifier is a strict allowlist, not a sandbox:

- A command is split on `;`, `&&`, `||`, `|`, `&`, newlines and parentheses. **Every** part must be a known read-only program with arguments that keep it read-only.
- Unknown programs, command substitution (`` `…` `` or `$(…)`), process substitution, redirects into files, and wrappers such as `sudo`, `su`, `tee`, `xargs` or `eval` always need approval.
- Programs with both read and write modes are checked by their arguments. For example `systemctl status` is read-only, `systemctl restart` is not; `find` with `-delete` or `-exec` needs approval.
- Most `git` commands need approval, because repository configuration can make git run programs.

A harmless command that the classifier does not understand costs you one extra click. That is deliberate: the rules stay strict rather than clever.

> **Warning:** Approving a command is the same as typing it into a terminal yourself. The classifier decides what *needs* approval; it does not make an approved command safe. If you do not understand a command, deny it and ask the assistant to explain.

## Docker and Kubernetes

The assistant also has read-only tools for containers and clusters — listing containers, reading the last lines of logs, inspecting a container, describing Kubernetes objects and reading events — with environment and Secret values redacted. These follow the same access rules as the UI and never change anything. A change such as `docker restart web` goes through `run_command` and needs approval like any other change. The assistant never changes a Kubernetes cluster.

## What is recorded

Every step is in the [audit log](/docs/monitoring/audit-log) against the target server:

| Action | When |
| --- | --- |
| `ai.command_approved` | You approved a command |
| `ai.command_denied` | Denied — by you, by the timeout, by a disconnect or because access was revoked |
| `ai.command_run` | A command ran (read-only or approved), with its exit code |
| `ai.docker_read`, `ai.kube_read` | The assistant read container or cluster data |

Commands the assistant runs are also recorded like any one-shot command run when session recording is on, so you can replay their output under **Recordings**. See [Session recordings](/docs/monitoring/session-recordings).
