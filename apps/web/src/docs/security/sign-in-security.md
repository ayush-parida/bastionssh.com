---
title: Sign-in security
section: security
order: 30
summary: How BastionSSH slows down password guessing, alerts you about new devices, and lets you see and end your sessions.
keywords: [login, lockout, failed sign-in, brute force, new device, known devices, sessions, sign out, rate limit]
---

BastionSSH protects sign-in in several layers that need no setup: a short pause after repeated wrong passwords, alerts when your account is used from a new device, and a list of every browser signed in to your account. For stronger protection, add a [passkey](/docs/security/passkeys-and-backup-codes) or use [single sign-on](/docs/security/single-sign-on).

## Failed passwords and the sign-in pause

When someone types **five wrong passwords for one account within 15 minutes** — from any mix of addresses — password sign-in for that account is **paused**:

| Pause in a row | Length |
| --- | --- |
| 1st | 1 minute |
| 2nd | 2 minutes |
| 3rd | 4 minutes |
| 4th | 8 minutes |
| 5th and later | 15 minutes (the maximum) |

The backoff is forgotten after a quiet day. A correct password clears the count of failures.

This is on top of the per-address limit of **10 sign-in attempts a minute**.

### Why the pause is short

Anyone who knows your email address can trigger the pause, so it must never become a way to keep you out. That is why it is capped at 15 minutes, and why:

- **Signing in with a passkey is never paused** — and it ends the pause.
- An admin-issued **password reset link** also ends it (see [Team and invites](/docs/access/team-and-invites)).

Addresses with no account are paused in exactly the same way, so the response never reveals which accounts exist.

### What gets recorded

- Each wrong password is in the [audit log](/docs/monitoring/audit-log) as `user.login_failed`.
- Each pause is recorded as `user.login_locked`.
- When email is configured on the instance (`SMT_SMTP_URL`), the account holder is emailed about the pause — at most once an hour.

## New-device alerts

Each account remembers the devices it signs in from. A "device" is deliberately coarse:

- the **browser and operating system family** (for example "Firefox on Linux" — versions are ignored, so browser updates do not count as new), and
- the **network** you came from: the /24 block for IPv4 or the /48 block for IPv6, so a changing address inside the same network is not new either.

The device is stored as a hash, not as your address. When you sign in from a combination the account has not used before:

- the sign-in is audited as `user.login_new_device`, and
- with email configured, you get an email about it.

Your very first sign-in is not reported as new.

### Known devices

Go to **Settings → Known devices** to see where your account has signed in from. Click **Forget this device** next to one to be told again the next time it is used — handy after a trip or after using a shared computer. Devices not used for **180 days** are forgotten automatically.

## Your sessions

**Settings → Your sessions** lists every browser currently signed in to your account, including the one you are using.

- Click **Sign out this session** next to one you do not recognise.
- Click **Sign out other sessions** to end every session except the current one.

A browser session lasts at most 7 days.

If you suspect someone else is using your account:

1. Sign out other sessions.
2. Change your password under **Settings** (you confirm with your passkey if you have one).
3. Check **Settings → Known devices** and forget anything unfamiliar.
4. Review and revoke your [API tokens](/docs/security/api-tokens) — they are not sessions and keep working until revoked or expired.
5. Ask an admin to check the audit log for your account.

## What admins can do

People with the **Members** module at Operate can act on members whose access is within theirs (on **Team & Access → Members**):

- **Sign out everywhere** — ends every session and closes live terminals, file sessions and AI chats.
- **Suspend** — signs them out and blocks them from the organization until reactivated.
- **Issue password reset link** and **Reset passkeys** — for locked-out members.

Owners control organization-wide sign-in policy under **Team & Access → Members → Sign-in security**: **Require passkeys for this organization** and **Backup-code sign-ins can only enroll a new passkey**. See [Passkeys and backup codes](/docs/security/passkeys-and-backup-codes).

## Behind a reverse proxy

Rate limits, the pause and new-device detection all depend on the client's real IP address. If BastionSSH runs behind Caddy, nginx or Traefik, the operator must set `SMT_TRUST_PROXY` (usually `1`); otherwise every user shares the proxy's address and one rate-limit bucket. See [Installing and upgrading](/docs/operations/installing-and-upgrading).
