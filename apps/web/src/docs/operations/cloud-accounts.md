---
title: Cloud accounts
section: operations
order: 40
summary: Import and keep servers in sync from AWS, Google Cloud, Azure, DigitalOcean and Hetzner Cloud with read-only credentials.
keywords: [cloud, aws, ec2, gcp, google cloud, azure, digitalocean, hetzner, sync, import, inventory, tags]
---

Instead of adding every cloud server by hand, register a cloud account once. BastionSSH lists the account's instances and adds them as servers, then keeps them up to date: new instances are imported, changed IP addresses are picked up, and stopped or deleted instances are flagged. It only ever **reads** from your cloud account; nothing is created, changed or deleted there.

## Supported providers

| Provider | Credential | Minimum permission |
| --- | --- | --- |
| AWS EC2 | Access key ID and secret access key | `ec2:DescribeInstances`, `ec2:DescribeRegions` |
| Google Cloud | Service account JSON key (paste the whole file) | Compute Viewer on the project |
| Microsoft Azure | Tenant (directory) id, client (application) id, client secret, subscription id | Reader on the subscription |
| DigitalOcean | Personal access token | Read scope |
| Hetzner Cloud | Project API token | Read |

Create a dedicated read-only credential for BastionSSH rather than reusing an admin one. Credentials are encrypted at rest and never shown again.

## Add an account

1. Open **Cloud Accounts** in the sidebar and click **Add account**.
2. Give it a **Name** (for example `Production (AWS)`) and choose the **Provider**.
3. Enter the credential fields. The form explains where to create each one.
4. For AWS, optionally list **Regions** (`us-east-1, eu-west-1`). Leave it blank to scan every enabled region, which is slower.
5. Set the **SSH username for imported servers** (for example `ubuntu`, `ec2-user` or `root`) and the **SSH key for imported servers**. Every imported server starts with these; you can change them per server later.
6. Leave **Auto-import new instances as servers** and **Sync periodically** on unless you want otherwise.
7. Click **Add**. BastionSSH checks the credentials first ("Checking credentials…"), saves the account and starts the first sync.

## What a sync does

| Instance | Result |
| --- | --- |
| New, with a public or private IP | Imported as a server (public IP preferred). Only when auto-import is on. |
| New, with no IP at all | Skipped and counted in the summary |
| Already imported | Host, region, state and provider tags refreshed. Your name, tags, credentials and notes are never overwritten. |
| No longer returned by the provider | Server marked **missing**. It is never deleted. |

Each account shows the result of its last sync ("Synced … · N discovered, …" or "Sync failed: …").

Servers whose instance is **stopped** or **missing** are left out of health checks, so they do not raise offline alerts (see [Health monitoring & alerts](/docs/monitoring/health-monitoring)).

## Tags

Imported servers get two tags of their own: `cloud:<provider>` (for example `cloud:aws`) and the region. You can use these in saved commands and in role tag selectors.

The provider's own tags (AWS tags, GCP labels, Azure tags, DigitalOcean and Hetzner labels) are shown on the server as **provider tags**, drawn dashed with a cloud icon, and refreshed on every sync. They are display only: role tag selectors and saved-command tag targets never match them.

> **Note:** This is deliberate. Whoever can tag instances in your cloud console should not be able to decide who reaches those servers in BastionSSH. Servers imported by older versions kept the provider's tags as real tags; remove any you do not want used for access.

## Managing accounts

Each account has these actions:

| Action | What it does | Needs |
| --- | --- | --- |
| **Sync now** | Runs a sync immediately | operate on the account |
| **Test** | Checks the credentials without importing anything | manage |
| **Pause** / **Resume** | Stops or restarts the scheduled sync (manual sync still works) | manage |
| **Edit** | Change name, regions, username, key, auto-import, sync | manage |
| Delete (bin icon) | Removes the account; imported servers are **kept** and unlinked | manage |

Adding an account and changing its credentials are for admins. A member who manages an account through a custom role can rename it, change its regions, username and auto-import, pause or resume sync, test, sync and delete it, but cannot swap in other credentials or choose the SSH key imported servers use. See [Resource grants](/docs/access/resource-grants).

## Instance settings

The sync schedule is set with environment variables on the BastionSSH container (defaults shown):

```bash
SMT_CLOUD_SYNC_ENABLED=true     # false turns the scheduled sync off; Sync now still works
SMT_CLOUD_SYNC_INTERVAL=15      # minutes between syncs (minimum 5)
SMT_CLOUD_REQUEST_TIMEOUT=30000 # per-request timeout to the provider, in ms
```

## Troubleshooting

- **Sync failed: …** with a permission or authorization error — the credential lacks the permission in the table above. For AWS, both `ec2:DescribeInstances` and `ec2:DescribeRegions` are needed.
- **Instances are skipped** — they have neither a public nor a private IP. Give them one, or add the server by hand.
- **Imported servers cannot connect** — check the SSH username and key on the account. Instances reached only by private IP may need a jump host or an agent (see [Connectivity agents](/docs/operations/connectivity-agents)).
