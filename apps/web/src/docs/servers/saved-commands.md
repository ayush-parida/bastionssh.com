---
title: Saved commands
section: servers
order: 40
summary: Save commands with {{variables}}, then run them on one server, a hand-picked list, or every server with a tag, and read each server's output side by side.
keywords: [saved commands, run, fan-out, tags, variables, placeholders, bulk, multiple servers]
---

**Saved Commands** keeps the commands your team runs again and again — restart a service, check disk space, tail a log — so anyone allowed can run them with a click, on one server or many at once, without opening a terminal.

## Creating a command

1. Open **Saved Commands** and click **New command**.
2. Fill in:
   - **Name** — what people will see, e.g. "Restart nginx".
   - **Default server** (optional) — the server it normally runs on, or **Any server — choose at run time**.
   - **Command** — the shell command. Use `{{name}}` for anything that changes between runs.
   - **Category** (optional) — a short label shown next to the name, such as "Maintenance".
3. Click **Save**.

As you type, the form lists the variables it found, e.g. `{{service}}`.

```bash
sudo systemctl restart {{service}} && systemctl status {{service}} --no-pager
```

Creating saved commands needs the *manage* level on the Saved Commands module (admins by default). Editing and deleting a command needs *manage* on that command; a command used by a cron job cannot be deleted until the job is deleted or switched to another command.

## Running a command

1. Click **Run** on the command.
2. In the run panel, choose the **Servers** to run on:
   - tick servers one by one, or
   - click a tag next to **By tag:** to tick every server carrying it (click again to untick them).
   The command's default server, if it has one, is ticked for you. At least one server must be ticked.
3. Fill in a value for each variable.
4. Click **Execute** (or **Execute on N servers**).

Each server gets its own result block: **Queued…**, **Running…**, then **Success** or **Failed** with the exit code and duration, followed by standard output and, in red, standard error. With several servers the header counts how many have finished and how many failed.

### What the run does

- The command runs over SSH as the server's configured user, in a non-interactive shell. It cannot answer prompts — use `sudo` only where it needs no password, or a user with the rights it needs.
- Each run has a **5-minute** timeout.
- Output is capped: about 64 KB of standard output and 8 KB of standard error per server; anything beyond is cut and marked `[output truncated]`.
- Runs on many servers are spread out — at most five at a time — so a fan-out across a large fleet does not open hundreds of SSH connections at once.
- Every run is recorded (when the organization records sessions) and can be replayed under **Recordings**, and each run is audited as `command.run` with the list of servers.

> **Warning:** Variable values are inserted into the command **as typed**, not quoted. Whoever can run a command can shape the shell line — the same power as opening a terminal, which is why running needs *operate* on the server.

## Who can run what

To run a command, you need:

- the **Saved Commands** and **Servers** modules,
- the *operate* level on the command, and
- the *operate* level on **every** target server.

If even one target is a server you can only view, the whole run is refused with a message naming it, rather than silently skipping it. A tag only ever expands to servers you can access, so restricted members reach only their own servers when running by tag.

If a member loses access between starting a queued run and the run beginning, the run is refused and recorded as failed rather than executed.

## Tags and fan-out

Tags come from the server form (**Servers → Edit → Tags**). Tagging servers by role and environment (`web`, `db`, `prod`, `staging`) makes fan-out easy: **By tag: prod** then **web** ticks the union of both. Only the server's own tags count; provider tags shown on imported cloud servers are never used.

## Command runs and the queue

When Redis is configured (`SMT_REDIS_URL`, included in the standard Docker Compose setup) runs go through the background queue. Without it, BastionSSH runs them directly in the app process. Either way the result appears in the run panel within a second or so of finishing.

## Related

- [Cron jobs](/docs/servers/cron-jobs) — run a saved command on a schedule.
- [AI command approval](/docs/security/ai-command-approval) — commands proposed by the AI assistant need your explicit approval before they run.
- [Session recordings](/docs/monitoring/session-recordings)
