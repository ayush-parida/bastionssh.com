---
title: Roles and modules
section: access
order: 10
summary: How roles combine module levels and resources, what the built-in roles give, and how to create, edit, clone and reset roles.
keywords: [roles, modules, owner, admin, operator, viewer, no access, custom role, permissions, rbac]
---

Every member of an organization holds **one or more roles**. A role is a named bundle of two things:

- **Modules** — which parts of the app its members may use (Servers, Kubernetes, Audit Log…) and at what level.
- **Resources** — which servers, clusters, connections, saved commands and cron jobs they reach, and at what level. These are covered in [Resource grants](/docs/access/resource-grants).

There is only one kind of role. The built-in roles and the roles you create yourself use the same editor and follow the same rules.

## How several roles combine

A member's access is the **union** of all their roles: for each module they get the highest level any of their roles gives, and the same for each resource. Holding an extra role can only add access, never take it away.

A module is **shown** to a member only when one of their roles turns it on **and** there is something in it for them — at least one item they can see, or the right to create items (`Manage`). A module that is off or empty disappears from the sidebar and the dashboard, and its pages answer "Page not found".

## Levels

Each module is set to **None**, **View**, **Operate** or **Manage**. Each level includes the ones before it. Not every module uses every level; the editor only offers the levels a module has.

| Module | View | Operate | Manage |
| --- | --- | --- | --- |
| Dashboard | Shown, limited to what the member can see | — | — |
| Servers | Servers granted to them | Servers granted to them | Add servers |
| Containers | Containers on their servers | Containers on their servers | Docker settings |
| Deployments | Apps, releases and status | Deploy, roll back, restart and stop | Set up servers, edit app config and secrets, delete apps |
| Kubernetes | Clusters granted to them | Clusters granted to them | Add clusters, Kubernetes settings |
| FTP, Object Storage, Cloud Accounts | Items granted to them | Items granted to them | Add connections or accounts |
| Saved Commands, Cron Jobs | Items granted to them | Items granted to them | Create, edit any they see |
| Monitoring & Alerts | Alerts of their servers and clusters | Acknowledge alerts | Alert rules, notification channels |
| DNS Lookup & Diagnostics | Run lookups | Diagnose with a login | — |
| AI Assistant | Chat (tools still checked per resource) | — | AI provider settings |
| Recordings | Their own recordings | All recordings of what they see | Delete, retention, recording settings |
| Audit Log | Read the log | Export | Retention, forwarding |
| SSH Keys | List keys | Use keys in forms | Create, import, rotate and delete keys |
| Agents | List agents and their status | — | Create, revoke and assign agents |
| Members | See members | Invite, suspend, sign out, reset passwords | — |
| Roles & access | See roles and effective access | — | Edit and assign roles, grants, approve access requests |
| Sign-in & SSO | See sign-in policy | — | Single sign-on, passkey policy, sign-in security |
| Organization settings | — | — | Org name, default role, Docker and Kubernetes settings |

For resource modules (Servers, Kubernetes, FTP and so on) the module level adds features that are not tied to one item. Which items someone reaches, and what they can do on each, comes from the role's resources.

> **Note:** Team & Access is split into three modules — Members, Roles & access, and Sign-in & SSO — so you can let someone invite people without letting them edit roles.

## The built-in roles

Every organization has five built-in roles. They cannot be deleted.

| Role | What it gives | Can be edited |
| --- | --- | --- |
| **Owner** | Everything, plus the owner-only actions listed below | No (locked) |
| **Admin** | Every module at its highest level and every resource managed | Yes |
| **Operator** | Operates every resource; AI Assistant, diagnostics with login, creates saved commands and cron jobs | Yes |
| **Viewer** | Sees every resource; dashboard, alerts (acknowledge), DNS lookups, own recordings, key and member lists | Yes |
| **No access** | Nothing beyond their own account | No (locked) |

A member who holds only **No access** (or no role at all) can still sign in and manage their own account — password, passkeys, sessions, backup codes. They see a page saying "You don't have access to anything yet", with **Request access** when the organization accepts requests.

Some actions stay with Owners whatever a role says: giving or taking the Owner role; suspending, signing out or removing an owner; sign-in policy (required passkeys, backup-code policy) and single sign-on; database backups; audit-log retention and forwarding; and recording settings and deleting recordings. An organization always keeps at least one active owner. There is no way to delete an organization from the app.

## Create a custom role

1. Go to **Team & Access → Roles** and click **New role**.
2. Enter a **Name** (for example "Web team"), pick a colour and add a short description.
3. Under **Modules**, choose a level for each module the role should turn on. The hint under each module says what the chosen level allows.
4. Under **Resources**, add the servers, clusters and other items the role reaches, each with a level. See [Resource grants](/docs/access/resource-grants).
5. Read the preview ("Members of this role will be able to…"), then click **Create role**.
6. The editor stays open so you can add **Members**, permanently or for a set time (30 minutes up to 7 days).

Adding a resource whose module is off turns that module on at **View** automatically, so the grant counts. If you later set the module back to **None**, the resources stay in the role but are marked as **parked** and give nothing until the module is on again.

## Edit, clone, reset and delete

On **Team & Access → Roles**, each role row has buttons:

- **Edit** (pencil) — change modules, resources and members. Locked roles and readers without `Manage` see an eye icon and a read-only view.
- **Clone** — copies the role as "<name> (copy)" and opens it. Every role except Owner can be cloned; this is a good way to start from Operator or Viewer.
- **Reset to default** — shown on Admin, Operator or Viewer once they have been changed (they carry a **Customized** badge). It puts the role back to what it gives out of the box.
- **Delete** — custom roles only. Members lose what only that role gave them immediately.

Editing a built-in role changes it for everyone who holds it. For example, setting Kubernetes to **None** on Viewer hides Kubernetes from every viewer.

> **Note:** Roles named "Operator (modules only)" or "Viewer (modules only)" with a **From migration** badge were created when an older version was upgraded, for members who were restricted to specific resources. They are ordinary editable roles.

## You can only give what you hold

Anyone who may edit roles, assign them or approve requests can only hand out permissions they hold themselves at the same or a higher level. The editors only offer roles you could give, and the server refuses anything beyond that. You cannot change your own roles.

## Default role for new members

At the top of **Team & Access → Roles**, **Default role for new members** decides which role an invite or a single sign-on account gets when none is picked. It starts as **Viewer**; changing it needs **Organization settings** at Manage.

Every change to a role, its members or its resources is recorded in the [audit log](/docs/monitoring/audit-log), and access that is taken away ends at once — open terminals, file sessions and live views on lost resources are closed.
