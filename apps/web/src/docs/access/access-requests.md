---
title: Access requests and time-limited access
section: access
order: 40
summary: Members ask for a role or resources for a set time with a reason; another admin approves, shortens or denies, and access ends by itself.
keywords: [access request, just in time, jit, temporary access, expiry, approve, deny, time-limited]
---

Not everyone needs standing access to everything. With **access requests**, a member asks for exactly what they need, for as long as they need it, and an approver decides. Approved access **ends on its own** — nobody has to remember to remove it.

## Who can request

Any member who does not already have everything can ask. That includes members with **No access**, who see a **Request access** button on their empty home page and on any "Page not found" page. Owners and admins, who already reach everything, cannot (and need not) request.

A request can be for:

- **A role** — for example "On-call" for 4 hours. Approval adds them to the role until the time is up.
- **Resources of one type at a level** — for example Operate on two servers, or View on a cluster. Approval adds time-limited personal grants (see [Resource grants](/docs/access/resource-grants)).

For servers, members can pick servers they cannot use yet **by name**, when the organization allows it (see Policy below). For every other type, they can ask for a higher level on items they can already see. Cluster requests can name **namespaces** instead of the whole cluster.

## Request access

1. Go to **Team & Access → Members** and click **Request access** in the **Access requests** section (or use the button on the No access page).
2. Choose a **Role**, or a **Type**, a **Level** and the items you need. Items you already have at that level are greyed out.
3. Choose **For how long**. The default is 2 hours, or the organization's maximum if that is lower.
4. Write a **Reason**, such as a ticket number or what you need to do.
5. Submit. Your request appears under **Access requests** with its status; **Cancel** withdraws it while it is pending.

Limits keep the queue sane: at most 10 pending requests per member, 20 new requests per hour, and a pending request that nobody decides **lapses after 3 days**.

## Approve or deny

People whose roles give **Roles & access** at Manage see pending requests on **Team & Access → Members → Access requests**.

1. Read who asked, for what, for how long and why.
2. To give less time than asked, pick a shorter duration in **Approve for**. Approval can shorten the time, never extend it.
3. For a cluster request, untick namespaces to narrow it. A whole-cluster request can also be narrowed to some namespaces. You cannot add namespaces that were not asked for.
4. Click **Approve**, or **Deny** (you can optionally say why).

Rules the server enforces:

- **You cannot approve your own request.** Another approver must decide.
- **You can only approve what you hold yourself.** If the request gives more than your own roles, approval is refused.
- A **suspended** member's request cannot be approved, and suspending or removing a member cancels their pending requests.

When a request is created, approved or denied, a notice goes to the organization's chat and email [notification channels](/docs/monitoring/notification-channels) (not to paging tools such as PagerDuty). With email configured, approvers are emailed about new requests and the requester about the decision. Every step is in the [audit log](/docs/monitoring/audit-log).

## When time runs out

- Expired access stops working **immediately** — every access check ignores it.
- A background sweep runs every minute. It removes expired grants and role memberships and closes anything still open on them: terminals, file sessions, Docker and Kubernetes streams and shells.
- If the member already held a role for longer than the approval, the longer membership stays as it is.

A server or cluster request made at your normal level (not a higher one) follows your role: if your role changes before it expires, the granted access changes with it.

## Grant time-limited access directly

Approvers do not need to wait for a request. Anywhere access is given you can choose an expiry instead of **Permanent** — from **For 30 minutes** to **For 7 days**:

- When adding a member to a role (in the role editor or in the member's access dialog).
- On each resource entry of a role or a member's personal grants.

Temporary roles and grants show an expiry badge ("expires in 3h") in the member list, the access dialog and the [effective access](/docs/access/effective-access) view.

## Policy

Approvers can open **Policy** in the Access requests section:

| Setting | Default | Effect |
| --- | --- | --- |
| **Show server names to restricted members** | On | Members can see the names (only — never addresses or tags) of servers they cannot use, so they can ask for them. When off, they can only ask for more time or a higher level on servers they already have. |
| **Longest access a member may ask for** | 8 hours | The maximum duration of a request, from 30 minutes to 7 days. |

Policy changes are audited.
