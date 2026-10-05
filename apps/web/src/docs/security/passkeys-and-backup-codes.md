---
title: Passkeys and backup codes
section: security
order: 10
summary: Add passkeys to sign in without a password or as a second step, keep backup codes for a lost device, and require passkeys for the whole organization.
keywords: [passkey, webauthn, fido, backup codes, recovery, two-factor, 2fa, mfa, require passkeys, step-up]
---

A **passkey** lets you sign in with your fingerprint, face, device PIN or a security key instead of typing a password. BastionSSH uses passkeys (WebAuthn) as its second factor: once your account has one, signing in with your password also asks for it.

> **Note:** BastionSSH does not offer authenticator-app (TOTP) codes. Passkeys and their backup codes are the second factor.

## Add a passkey

1. Go to **Settings → Passkeys** and click **Add passkey**.
2. Give it a **Name** you will recognise, such as "MacBook Touch ID" or "YubiKey".
3. For your **first** passkey, enter **Your password** again. You must also have signed in within the last 15 minutes; if not, sign in again first.
4. Follow your browser's prompt.

Adding your first passkey signs out your other sessions that only used a password. After that, the app suggests generating backup codes — do it. You can rename (pencil) or remove (bin) a passkey from the same list, and keep up to 20.

With email configured on the instance, you are emailed whenever a passkey is added to your account.

### Requirements

- Browsers only offer passkeys on **HTTPS** pages or on **localhost**. On plain HTTP the page says "Passkeys need this page to be served over HTTPS".
- A passkey is bound to the instance's domain. Passkeys made while the instance ran on another address (for example `localhost`) do not work after moving to a domain; enroll them again after the switch. See [Installing and upgrading](/docs/operations/installing-and-upgrading).

## Sign in with a passkey

On the sign-in page you can:

- Click **Sign in with a passkey** to sign in with no password at all, or
- Enter your email and password, then confirm with your passkey when asked.

A passkey sign-in is never paused by failed password attempts, and it ends such a pause. See [Sign-in security](/docs/security/sign-in-security).

## Confirming sensitive actions

Once your account has a passkey, some actions ask you to confirm with it again (a "step-up"), even though you are signed in:

- changing your password,
- creating API tokens,
- generating backup codes,
- issuing password reset links or resetting someone's passkeys (admins),
- revealing secret values, downloading database backups, and changing audit retention or forwarding,
- changing single sign-on or the organization's passkey requirement (owners).

## Backup codes

Backup codes get you in if you lose the device that holds your passkey.

1. Go to **Settings → Passkeys**, find **Backup codes** and click **Generate** (or **Regenerate**). Confirm with your passkey.
2. Ten one-time codes in the form `XXXXX-XXXXX` are shown **once**. Copy or download them and keep them somewhere safe, like a password manager.
3. Tick **I have saved these codes** to close the dialog.

Generating a new set invalidates the old one. The Passkeys heading warns you when you have no codes or few left.

### Using a backup code

1. Sign in with your email and password.
2. When asked for your passkey, choose **Lost your passkey? Use a backup code instead**.
3. Enter one code. Case does not matter and the dash is optional.

By default, a backup-code sign-in is a **recovery session**: it can only add a new passkey. The app opens **Settings → Passkeys**; add a passkey on this device and confirm with it, and you get full access back. Then remove the lost passkey and generate new codes.

Other limits:

- Backup codes cannot be used for passwordless sign-in or to confirm a sensitive action.
- After five wrong codes the pending sign-in is dropped and you start again.
- Removing your last passkey, or an admin resetting your passkeys, deletes your backup codes.
- With email configured, you are emailed when codes are generated and each time one is used.

> **Warning:** Codes are stored as a keyed hash derived from the instance's `SMT_SESSION_SECRET`. If the operator rotates that secret, every backup code stops working and everyone must generate new ones.

## Lost passkey and no backup codes

Ask an admin or owner whose access is higher than yours to use **Reset passkeys** on **Team & Access → Members**. It removes all your passkeys and backup codes and signs you out; you then sign in with your password and add a new passkey. This is refused for someone who also belongs to another organization. See [Team and invites](/docs/access/team-and-invites).

## Require passkeys for the organization

Owners can make passkeys mandatory under **Team & Access → Members → Sign-in security → Require passkeys for this organization**.

When it is on:

- Members must have used a passkey in their current session (alone, or after their password) to do anything in the organization.
- Anyone without a passkey is asked to create one right after signing in. The section shows how many active members have no passkey yet, and turning the policy on asks you to confirm when some do not.
- Open terminals, file sessions and AI chats of members whose session did not use a passkey are closed.
- Only API tokens created from a passkey-verified session keep working; older ones show a **No passkey** badge and must be recreated. See [API tokens](/docs/security/api-tokens).

To turn it on, your own session must have used a passkey, so you cannot lock yourself out. Other members see whether the policy is on.

### Backup-code policy

The same section has **Backup-code sign-ins can only enroll a new passkey** (on by default). Turn it off to give backup-code sign-ins full access straight away. Changes are audited as `org.backup_code_policy`.

Single sign-on users still need a passkey where one is required, unless the owner trusts the identity provider's phishing-resistant MFA. See [Single sign-on](/docs/security/single-sign-on).
