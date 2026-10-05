---
title: Deployment permissions
section: deployments
order: 110
summary: Who can see, deploy, configure and delete apps — the Deployments module, server access levels, and bastion.yml permissions.deploy.
keywords: [permissions, access, roles, module, operate, manage, view, admin, operator, viewer, permissions.deploy, who can deploy]
---

What a member may do with an app is the **lower** of two levels:

1. their level in the **Deployments** module (from their roles), and
2. their access level on **the server** the app runs on.

Built-in roles give Deployments as: **Admin** manage, **Operator** operate, **Viewer** view. Custom roles have no Deployments access until you add it. A member without the module does not see Deployments at all.

| Level | Can |
| --- | --- |
| **view** | see the apps, their status, releases, config, domains and certificates |
| **operate** | also deploy, roll back, restart and stop apps, and re-run the nginx helper |
| **manage** | also set up and reinstall, create apps, edit `bastion.yml` and `.env`, reveal a secret (with a passkey), and delete apps |

Buttons a member may not use are hidden, and the server refuses the request regardless.

## permissions.deploy

Deploying runs the uploaded code with the app's secrets and volumes, so for some apps you may want only managers to deploy. In the app's `bastion.yml`:

```yaml
permissions: { deploy: manage }
```

or **Who may deploy → manage** in the Config form. Then deploying and rolling back that app need **manage**; operators can still restart and stop it, and the app's page tells them why Deploy is unavailable.

- The default (no `permissions`) is `operate`.
- If the config cannot be read, BastionSSH assumes `manage`.
- The setting lives on the server like the rest of the config; changing it needs manage.

## Audit

BastionSSH records setup, deploys (start and result), rollbacks, restarts and stops, config and `.env` changes (variable names only), secret reveals and deletes in the audit log. Commands run from a shell on the server bypass BastionSSH and are not recorded there.

## The docs

These pages are open to every member, whatever their roles: they are part of the app and show nothing about your organization.
