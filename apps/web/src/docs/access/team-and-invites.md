---
title: Team and invites
section: access
order: 30
summary: Invite people with an invite link, choose their roles, and suspend, sign out, reset or remove members.
keywords: [team, invite, members, suspend, reactivate, password reset, sign out everywhere, remove member, default role]
---

Everything about the people in your organization lives on **Team & Access** in the sidebar. The **Members** tab lists everyone with their roles, status, number of passkeys and when they were last active. People with **Roles & access** also see the **Roles** and **Access checker** tabs.

What you can do here depends on the **Members** module of your roles:

| Level | Allows |
| --- | --- |
| View | See the member list |
| Operate | Invite people, revoke invites, suspend and reactivate, sign members out, issue password reset links, reset passkeys, remove members |

You can only act on members whose access is **within your own**. Password and passkey resets need the member's access to be **strictly less** than yours, since they hand over the account. Nobody can suspend, sign out or remove themselves from this page.

## Invite someone

BastionSSH does not email invites. It creates a one-time link that you send yourself (chat, email, ticket).

1. Go to **Team & Access → Members** and click **Invite person**.
2. Enter the person's **Email**.
3. Under **Roles**, tick the roles they should get. The organization's default role is ticked to start with. Only roles you could give yourself are offered. Ticking none gives them **No access** until someone assigns a role.
4. Click **Create invite**. The link is copied to your clipboard and shown once in a yellow box.
5. Send the link to the person. If you lose it, revoke the invite and create a new one.

Invite links expire after **7 days**. Pending invites are listed under **Pending invites** with their roles and expiry; the bin icon revokes one. You cannot invite someone who is already a member, or send a second invite to an address that still has a valid one.

### Accepting an invite

The person opens the link and either:

- **Creates an account** — enters the invited email address, their name and a password (at least 8 characters), or
- **Signs in to accept** — if they already have an account (for example in another organization), they sign in as it.

The accept form asks for the full email address and only shows a masked hint (`de•@ex•••••.com`), so a forwarded link is useless to anyone who does not know the address.

## The default role and single sign-on

**Default role for new members** is set on **Team & Access → Roles** (it needs the **Organization settings** module at Manage). Invites start with it ticked. When [single sign-on](/docs/security/single-sign-on) creates accounts on first sign-in, it uses its own **Role for new accounts** setting, which can be any role except Owner. The default role starts as **Viewer**.

## Change a member's roles

Click the access icon on a member's row to open their access dialog. Under **Roles**:

1. Pick a role from **Add a role…**.
2. Choose how long it lasts: **Permanent**, or **For 30 minutes** up to **For 7 days**.
3. Click the **×** on a role chip to take it away.

You can also manage who holds a role from the role itself, under **Team & Access → Roles → (role) → Members**. See [Roles and modules](/docs/access/roles-and-modules).

## Suspend and reactivate

**Suspend** (the person-with-cross icon) blocks a member from this organization without removing them:

- All their browser sessions are signed out.
- Their open terminals, file sessions and AI chats in this organization are closed.
- Their pending access requests are cancelled.
- Their roles and grants are kept, ready for when they come back.

**Reactivate** (the person-with-tick icon) lets them sign in again. The organization must always keep at least one active owner.

## Sign out everywhere

**Sign out everywhere** (the log-out icon) ends every browser session the member has and closes their live terminals, file sessions and AI chats. It is useful when a laptop is lost. They can sign straight back in with their credentials; to stop that, suspend them instead.

Members sign out their own other browsers under **Settings → Your sessions**, see [Sign-in security](/docs/security/sign-in-security).

## Issue a password reset link

When someone forgets their password:

1. Click the key icon (**Issue password reset link**) on their row and confirm.
2. If you have a passkey, confirm with it.
3. Copy the link from the yellow box and send it privately.

The link works once and expires after **24 hours**. Issuing another link cancels the previous one. Using it signs the member out everywhere and ends any pause on password sign-in caused by wrong passwords.

> **Note:** Password resets need a signed-in browser (not an API token). They are refused for someone who also belongs to **another organization**, because a password belongs to the account, not to one organization.

## Reset passkeys

If a member lost their passkey and has no backup codes, click the fingerprint icon (**Reset passkeys**). This removes all their passkeys and backup codes and signs them out. They sign in with their password and enroll a new passkey. Like a password reset, it needs your passkey confirmation when you have one and is refused for members of other organizations. See [Passkeys and backup codes](/docs/security/passkeys-and-backup-codes).

## Remove a member

The red bin icon removes a member from the organization. Their roles, personal grants and pending access requests go with the membership, any unused reset link is cancelled, and everything they had open is closed. Their account still exists (it may belong to other organizations); to bring them back, send a new invite.

Every invite, role change, suspension, reset and removal is recorded in the [audit log](/docs/monitoring/audit-log).
