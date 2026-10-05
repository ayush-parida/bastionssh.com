---
title: API tokens
section: security
order: 40
summary: Create personal API tokens for scripts and CI, choose read-only or read/write, and call the API with a Bearer header.
keywords: [api, token, bearer, automation, ci, scripts, read-only, scopes, export]
---

API tokens let scripts, CI pipelines and other tools call the BastionSSH API without signing in through a browser. A token belongs to **you** and acts as you: it can never do more than your own roles allow.

## Create a token

1. Go to **Settings → API tokens** and click **New token**.
2. Enter a **Name** that says where it is used, for example `deploy-pipeline`.
3. Choose when it **Expires**: **30 days**, **90 days**, **1 year** or **Never**.
4. Leave **Allow writes** unticked for a read-only token, or tick it to let the token make changes.
5. Click **Create token**.
6. Copy the token from the box — **it is shown only once**. Only a hash is stored; if you lose it, revoke it and create another.

Tokens look like `smt_<prefix>_<secret>`. The short prefix is what the list shows to tell your tokens apart.

### Read-only or read/write

| Scope | What the token can do |
| --- | --- |
| **read-only** (default) | Acts as a viewer whatever your roles: every level is capped at View. Good for reporting, dashboards and audit exports. |
| **read/write** | Anything you can do — never more. |

Your roles are checked on every request, so if your access is reduced, your tokens lose it at the same moment.

### When a passkey is needed

A token outlives the sign-in that created it, so it can only be as strong as that sign-in:

- If your account has a passkey, or you belong to any organization that requires passkeys, you must have confirmed with your passkey in this session to create a token (the app asks you).
- In an organization that **requires passkeys**, only tokens created from a passkey-verified session work. Older tokens show a **No passkey** badge; create a new one and revoke the old.
- A session that signed in through one organization's [single sign-on](/docs/security/single-sign-on) cannot create tokens if your account also belongs to other organizations, because a token works in every one of them. Sign in with a password or passkey instead.
- A token cannot create other tokens.

## Use a token

Send it in the `Authorization` header as a Bearer token. API paths start with `/api`.

```bash
export BASTION_URL=https://bastion.example.com
export BASTION_TOKEN=smt_xxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Who am I, and in which organization?
curl -s -H "Authorization: Bearer $BASTION_TOKEN" "$BASTION_URL/api/auth/me"

# List the servers this token can see
curl -s -H "Authorization: Bearer $BASTION_TOKEN" "$BASTION_URL/api/servers"
```

A useful example is exporting the audit log on a schedule (this needs the **Audit Log** module at Operate or higher):

```bash
curl -s -H "Authorization: Bearer $BASTION_TOKEN" \
  "$BASTION_URL/api/audit/export?format=jsonl&from=2026-10-01T00:00:00Z" \
  -o audit-october.jsonl
```

See [Audit log](/docs/monitoring/audit-log) for the export options.

> **Note:** A token acts in your active organization. If you belong to several organizations, check `/api/auth/me` to see which one it lands in.

## What tokens cannot do

Some actions hand over accounts or sensitive data and need a person at a browser, not a token:

- issuing password reset links and resetting someone's passkeys,
- changing your password, and managing passkeys or backup codes,
- configuring single sign-on,
- revealing container environment values or deployment secrets,
- downloading database backups,
- creating other API tokens.

## Manage your tokens

**Settings → API tokens** lists your tokens with their scope (**read-only** or **read/write**), when each was last used, and when it expires (or **no expiry**). Expired tokens are marked **Expired** and no longer work.

- Click the bin icon to **revoke** a token. It stops working immediately.
- Each person manages only their own tokens; admins cannot see or revoke yours.

Creating and revoking tokens is recorded in the [audit log](/docs/monitoring/audit-log) as `api_token.create` and `api_token.revoke`.

## Good practice

- Create one token per tool or pipeline, so you can revoke one without breaking the others.
- Prefer **read-only** unless the tool really changes things.
- Give tokens an expiry. "Never" is convenient but easy to forget.
- Store tokens in your CI's secret store, never in a repository.
- If you are suspended or removed, your tokens stop working in that organization; if a laptop is lost, revoke its tokens as well as signing out its sessions (see [Sign-in security](/docs/security/sign-in-security)).
