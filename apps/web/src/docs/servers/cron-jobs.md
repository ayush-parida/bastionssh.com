---
title: Cron jobs
section: servers
order: 50
summary: Schedule commands that BastionSSH runs over SSH — cron syntax and timezones, run history, running now, and what the scheduler needs to work.
keywords: [cron, schedule, scheduled jobs, crontab, run history, timezone, redis, worker]
---

**Cron Jobs** are schedules that BastionSSH itself runs. At each scheduled time it connects to the server over SSH, runs the command, and keeps the exit code and output. Nothing is added to the server's own `crontab`, so you can see, pause and audit every scheduled task across your fleet in one place.

## Creating a cron job

1. Open **Cron Jobs** and click **New job**.
2. Fill in:
   - **Name** — e.g. "Nightly DB dump".
   - **Server** — the server to run on (one server per job).
   - **Cron schedule** — a standard five-field cron expression (see below). Below the field, **Next:** shows when it would next run, so you can check it before saving.
   - **Timezone** — an IANA timezone name such as `UTC`, `Europe/Berlin` or `America/New_York`. The schedule is read in this timezone, so `0 3 * * *` with `Europe/Berlin` runs at 03:00 Berlin time, daylight saving included.
   - **Saved command** (optional) — run one of your saved commands, or leave it at **None — use inline command**.
   - **Inline command** — the command to run when no saved command is picked, e.g. `/usr/local/bin/backup.sh`.
3. Click **Create**.

A job runs either a saved command or an inline command, not both. A saved command used by a cron job runs with its `{{variables}}` left as written — there is no place to fill them in — so pick commands without variables, or use an inline command.

Creating cron jobs needs the Cron Jobs module at *manage* (Operators, Admins and Owners by default), *operate* access to the job's server and, for a saved command, *operate* on that command.

## Cron syntax

The five fields are minute, hour, day of month, month and day of week:

```text
┌───────── minute (0–59)
│ ┌─────── hour (0–23)
│ │ ┌───── day of month (1–31)
│ │ │ ┌─── month (1–12)
│ │ │ │ ┌─ day of week (0–6, Sunday = 0)
│ │ │ │ │
* * * * *
```

| Expression | Runs |
| --- | --- |
| `0 * * * *` | Every hour, on the hour (the default) |
| `*/15 * * * *` | Every 15 minutes |
| `30 2 * * *` | Every day at 02:30 |
| `0 6 * * 1-5` | Weekdays at 06:00 |
| `0 0 1 * *` | Midnight on the first of each month |

An invalid expression is refused with the reason.

## The job list

The table shows each job's **Name**, **Schedule**, **Server**, **Next run** and **Status**. On each row:

- the **toggle** enables or disables the job (a disabled job keeps its history and stops being scheduled);
- **Run now** (the play icon) starts a run immediately, outside the schedule — even while the job is disabled;
- the **delete** icon removes the job;
- the expand arrow on the left opens the **run history**.

There is no edit form: to change a job's schedule or command, create a new job and delete the old one.

The **Dashboard** also lists active cron jobs.

## Run history

Each run shows its status (`running`, then `success` or `failure`), exit code, duration, start time, and the command's standard output and standard error. The list shows the latest 50 runs. A run counts as a success only when the command exits with code `0`.

Like saved commands, a run times out after **5 minutes**, and output is capped (about 64 KB of standard output, 8 KB of standard error).

## Whose job is it?

A cron job runs **as the person who created it**. Before every run, BastionSSH checks that this person is still a member, is not suspended, and still has the access needed to operate the job and its server. If not, the run is recorded as a failure with the reason instead of being executed. When someone leaves the team, review the jobs they created.

## What the scheduler needs

Scheduled runs go through a queue held in **Redis**:

- The standard Docker Compose setup includes a Redis container and sets `SMT_REDIS_URL`, so cron jobs work out of the box.
- Without `SMT_REDIS_URL`, you can still create jobs and use **Run now**, but scheduled runs **do not fire**; the server logs "Cron job not scheduled — set SMT_REDIS_URL to run cron jobs".
- Schedules are re-queued when the worker starts, so a restart or a flushed Redis does not lose them.

> **Note:** The queue worker runs inside the app process (`SMT_WORKER_IN_PROCESS=true`, the default). BastionSSH ships no separate worker process, so leave it at `true`: with Redis set and `SMT_WORKER_IN_PROCESS=false`, nothing takes jobs off the queue — scheduled runs, **Run now** and saved command runs stay queued and never execute.

## Permissions summary

| Action | Needs |
| --- | --- |
| See jobs and their history | *view* on the job |
| Disable | *operate* on the job |
| Enable | *operate* on the job, on its server and on the saved command it runs |
| Run now | *operate* on the job, on its server and on the saved command it runs |
| Create | Cron Jobs module at *manage*, plus *operate* on the server and the saved command |
| Delete | *manage* on the job, or the Cron Jobs module at *manage* |

Runs started with **Run now** are audited as `cron_job.run`.

## Related

- [Saved commands](/docs/servers/saved-commands)
- [Health monitoring & alerts](/docs/monitoring/health-monitoring)
