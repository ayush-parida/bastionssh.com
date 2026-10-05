---
title: Single sign-on (OIDC)
section: security
order: 20
summary: Let members sign in with Google Workspace, Microsoft Entra ID, Okta or any OpenID Connect provider, create accounts automatically and map groups to roles.
keywords: [sso, single sign-on, oidc, openid connect, google workspace, entra id, azure ad, okta, identity provider, groups]
---

Single sign-on lets your team sign in to BastionSSH with the identity provider (IdP) they already use. BastionSSH speaks **OpenID Connect** and ships presets for **Google Workspace**, **Microsoft Entra ID** and **Okta**; **Other OpenID Connect** covers any standard provider (Keycloak, Authentik, JumpCloud…).

> **Note:** SAML is not supported. Every provider listed above also speaks OpenID Connect.

Each organization has one provider. Setting it up is for **owners** (the panel only appears for them).

## Before you start

- The instance must be reachable at its public URL, set in `SMT_BASE_URL`. The redirect URI is built from it.
- The issuer must use `https://` (plain `http` is accepted only in development mode).
- Decide which **email domains** may sign in, for example `example.com`.

## Set up single sign-on

1. Go to **Team & Access → Members → Single sign-on**.
2. Copy the **redirect URI** shown at the top — it is `SMT_BASE_URL` followed by `/api/auth/sso/callback`.
3. At your provider, register a **web application** client with that redirect URI. Note its client ID and secret.
4. Back in BastionSSH, choose the **Provider** and fill in:

   | Field | What to enter |
   | --- | --- |
   | **Issuer URL** | Google: `https://accounts.google.com`. Entra ID: `https://login.microsoftonline.com/<tenant-id>/v2.0`. Okta: `https://<your-org>.okta.com` or an authorization server such as `…/oauth2/default`. Other: the issuer as it appears in `/.well-known/openid-configuration`. |
   | **Client ID** / **Client secret** | From step 3. The secret is encrypted and never shown again; leave it blank later to keep it. |
   | **Allowed email domains** | Exact domains, comma separated. Subdomains must be listed separately. |
   | **Role for new accounts** | The role given to accounts created by SSO. Any role except Owner. |

5. Click **Test discovery**. It checks that the discovery document and signing keys can be fetched. The client ID and secret are only proven by a real sign-in.
6. Tick **Enabled** and click **Set up single sign-on** (later, **Save**). You confirm with your passkey if you have one.
7. Open a private window and sign in with SSO yourself to make sure it works.

## How members sign in

On the sign-in page, members click **Sign in with SSO** and enter the organization's slug or their work email. Once SSO is configured, the panel also shows a direct sign-in link you can bookmark or share.

Every sign-in is checked thoroughly:

- The flow is authorization code with PKCE; the pending round trip expires after 10 minutes and is bound to the browser.
- The ID token's signature, issuer, audience, expiry and nonce are verified.
- The email must be **verified** by the provider and belong to an allowed domain.
- With Google, the token's hosted-domain (`hd`) claim must also be an allowed domain, so a personal Google account registered with a work address is refused.

## Accounts

An identity is remembered by the provider's subject id. On someone's first SSO sign-in:

- If an account with the same verified email **is already a member** of the organization, it is linked.
- Otherwise, with **Create accounts on first sign-in** ticked, a password-less account is created with the **Role for new accounts**.
- With it unticked, only existing members can use SSO.

An account that exists but belongs only to other organizations is never taken over.

## Map provider groups to roles (optional)

Open **Map provider groups to roles**:

1. Enter the **Groups claim** — the ID token claim that lists the user's groups (often `groups`). For Okta, BastionSSH asks for the `groups` scope.
2. Add rows mapping a **Group** name or ID to **viewer**, **operator** or **admin**.

At each sign-in, the highest mapped role replaces the member's role. **Owners are never changed** by the mapping.

## Options

| Option | Effect |
| --- | --- |
| **Enabled** | Turning it off ends every session that signed in through SSO. |
| **Create accounts on first sign-in** | See Accounts above. |
| **Require single sign-on** | Members other than owners can no longer sign in with a password or passkey. Their existing non-SSO sessions are refused from their next request, and their open terminals and file sessions end. Owners keep password and passkey sign-in as a way in if the IdP is down. API tokens keep working. |
| **Trust phishing-resistant MFA reported by the provider** | When the ID token says the sign-in used a security key or passkey (`amr` contains `hwk` or `fido`, or `acr` is `phr`/`phrh`), it counts as a passkey sign-in for **Require passkeys**. Only turn this on if your IdP really enforces it. |

> **Warning:** Sign in with SSO yourself before ticking **Require single sign-on**, to be sure it works.

## SSO sessions are tied to the organization

A session that signed in through an organization's SSO only works in that organization. If the account also belongs to other organizations, that session cannot add passkeys, backup codes or API tokens (those work everywhere), and under **Settings → Your sessions** it lists and signs out only that organization's SSO sessions. Sign in with a password or passkey to manage everything.

An SSO sign-in is not passkey-verified, so in an organization that [requires passkeys](/docs/security/passkeys-and-backup-codes) the member is still asked to create or use one — unless the provider's MFA is trusted as above.

## Changing or removing the provider

**Remove** signs out everyone who signed in through SSO. Disabling the provider, or pointing it at another issuer or client, also signs out every SSO session; a new issuer or client additionally forgets existing identity links, so people are matched by email again.

Suspension is checked at every SSO sign-in and request. Every sign-in, refusal, link, created account and configuration change is recorded in the [audit log](/docs/monitoring/audit-log).
