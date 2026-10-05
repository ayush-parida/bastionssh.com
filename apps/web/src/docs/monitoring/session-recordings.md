---
title: Session recordings
section: monitoring
order: 30
summary: Replay terminal, container and pod shell sessions and one-shot command runs, and control what is recorded and for how long.
keywords: [recordings, replay, asciicast, terminal, session, keystrokes, retention, audit]
---

BastionSSH records what happens in the terminals it opens, so you can replay a session later to see exactly what was shown on screen. Recordings use the open [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/) format and are compressed when the session ends.

## What is recorded

| Kind | What it is |
| --- | --- |
| Terminal | An interactive SSH session opened from **Servers → a server → Connect** |
| Command | A one-shot run: a saved command, or a command the AI assistant ran after your approval |
| Container | A shell opened inside a Docker container (see [Exec shells & recordings](/docs/docker/exec-shells-and-recordings)) |
| Pod | A shell opened inside a Kubernetes pod (see [Logs & pod shells](/docs/kubernetes/logs-and-pod-shells)) |

By default only the **output** is recorded: what the server sent back to the screen. What people type is not captured unless an owner turns on keystroke recording (below).

> **Note:** Cron job runs are not recorded as sessions. Their output and exit codes are kept in the job's run history instead (see [Cron jobs](/docs/servers/cron-jobs)).

## Finding a recording

Open **Recordings** in the sidebar. The **Session Recordings** list can be filtered by:

- **Server** (or **All servers**)
- **User** (or **Everyone**)
- **From** date
- **Container** name or id, to find shells in a particular container

Icons on a row show when keystrokes were recorded and when the recording was **truncated at the size limit**.

You can also reach a recording from the **Audit Log**: events that belong to a recorded session have a play button.

## Playing a recording

Click a recording to open the player.

- **Play / pause**, a **speed** selector and a seek bar.
- Long idle stretches are shortened to 2 seconds, so a session where someone walked away for an hour does not play an hour of nothing.
- **Commands run over this session** lists the commands BastionSSH itself ran on that connection (saved commands and AI-run commands), each with its exit code. Click one to jump to that point. Commands a person typed by hand are not in this list; watch the playback (or the keystroke stream, if recorded) for those.
- **Download .cast** saves the file so you can play it with `asciinema play` or keep it elsewhere.

Viewing and downloading a recording are both written to the audit log.

## Who can see which recordings

| Who | Sees |
| --- | --- |
| Most members (Recordings module at **view**) | Only their own recordings |
| Recordings at **operate** or higher (admins and owners by default) | Everyone's recordings |
| Everyone | Never a recording of a server, cluster or container they cannot access |

Only **owners** can delete a recording (from the player), and they confirm with a passkey when they have one. A recording that is still running cannot be deleted.

## Recording settings (owners)

At the bottom of the **Recordings** page, owners control **Session recording** for the organization:

1. **Record sessions** — on by default. Turning it off means new sessions are not recorded.
2. **Record keystrokes** — off by default. When on, what members type is saved as a separate input stream.
3. **Keep recordings for** — 1 to 3650 days, default 90. A daily cleanup deletes older recordings.

Changes apply to sessions opened from then on; sessions already running keep the policy they started with. Each change is audited with the before and after values, and needs a passkey confirmation when the owner has a passkey.

> **Warning:** With keystrokes recorded, passwords typed into the terminal (at `sudo`, `su` or a database prompt) are captured too. There is no reliable way to tell when a prompt hides its input. Leave it off unless you need it.

## Storage and limits (instance operators)

Recordings are files on disk, not rows in the database.

```bash
SMT_RECORDINGS_DIR=/data/recordings   # inside the data volume by default
SMT_RECORDING_MAX_BYTES=52428800      # 50 MiB uncompressed per recording
```

- A session that outgrows the size limit keeps running; the rest of it is simply not recorded, and the recording is marked as truncated.
- If the directory cannot be written, sessions still open, unrecorded, and the error is logged.
- Recordings are **not** included in database backups. Back up `SMT_RECORDINGS_DIR` separately if you need to keep them (see [Backups & restore](/docs/operations/backups-and-restore)).
