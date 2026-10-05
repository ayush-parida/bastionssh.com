---
title: Guided actions
section: kubernetes
order: 50
summary: Fix common problems with a button — scale, restart a rollout, roll back, restart a pod, cordon a node, and suspend or run CronJobs — each with a preview and the equivalent kubectl command.
keywords: [kubernetes, scale, restart, rollout, rollback, revision, delete pod, cordon, uncordon, cronjob, suspend, run now, kubectl]
---

Guided actions fix the most common Kubernetes problems with a button instead of a command. Each one asks first, names the object it will change, shows what will happen, and sends the same minimal change to the API server that the equivalent `kubectl` command would.

You find them on an object's panel: click a workload, pod or node anywhere on a cluster's pages (the map, the **Apps** graph, the **Workloads** or **Nodes** tab, or a **Needs attention** card).

## Who can do what

| Action | Viewer | Operator | Admin / owner |
| --- | --- | --- | --- |
| Scale a Deployment or StatefulSet | — | Yes, unless turned off | Yes |
| Restart a rollout | — | Yes, unless turned off | Yes |
| Run a CronJob now, suspend or resume it | — | Yes, unless turned off | Yes |
| Restart (delete) a pod | — | Yes, unless turned off | Yes |
| Roll back a Deployment | — | — | Yes |
| Cordon or uncordon a node | — | — | Yes |

Owners and admins control the operator switches under **Settings → Kubernetes**:

- **Operators can scale and restart workloads** (on by default) — covers scaling, restarting a rollout, and triggering or suspending CronJobs.
- **Operators can delete (restart) pods** (on by default).

Custom roles can grant these per cluster or per namespace — see [Resource grants](/docs/access/resource-grants). Where a role lets a member do more in a namespace than on the cluster as a whole, panels in that namespace offer the extra actions.

> **Note:** BastionSSH roles decide which buttons appear. The cluster's own RBAC decides whether the change is allowed. If the credential lacks the permission, the action fails and the cluster's reason is shown. The Role in [Adding a cluster](/docs/kubernetes/adding-a-cluster) grants what these actions need.

## Every action has "What this does"

Each confirmation has a collapsible **What this does** section with the equivalent `kubectl` command, for learning:

```bash
kubectl scale deployment/web --replicas=5 -n shop
```

Nothing runs that command. BastionSSH sends the same patch to the API server itself. You can copy it to run elsewhere if you like.

## Scale

On a Deployment or StatefulSet panel, click **Scale**. Drag the slider (or type a number) and the **replica rings** show now → after: pods that will start in blue, pods that will stop in red. Confirm with **Scale *name* to *N***.

> **Warning:** If a HorizontalPodAutoscaler controls the workload, BastionSSH warns you: the autoscaler keeps the count between its minimum and maximum and will change your number back.

## Restart a rollout

**Restart rollout** (Deployments, StatefulSets, DaemonSets) replaces every pod with a fresh one. It sets the `kubectl.kubernetes.io/restartedAt` annotation on the pod template, exactly as `kubectl rollout restart` does. The confirmation tells you how the replacement will happen:

| Update strategy | What happens |
| --- | --- |
| `RollingUpdate` (default) | Pods are replaced one by one |
| `Recreate` | Every pod stops before new ones start — the app is down in between |
| `OnDelete` | Pods are only marked; each is replaced when it is deleted |

A paused rollout must be resumed first.

## Roll back a Deployment (admins)

A Deployment panel has a **Revisions** timeline: when each revision was made, its change-cause, its images, and the one running now highlighted. On a past revision, click **Roll back to this**. Before confirming you see what changes:

- the **images** that will change;
- the **environment variable names** that will be added or removed — only names are compared; values never leave the cluster.

Confirm with **Roll back *name* to revision *N***. A paused rollout must be resumed first.

## Restart a pod

A pod's panel offers **Restart this pod** when the pod has an owner (a ReplicaSet, StatefulSet, Job…): it is deleted, and its owner starts a fresh one in its place. A pod with **no owner** — or whose Job has already finished — gets **Delete this pod** with a stronger warning, because nothing will bring it back.

## Cordon and uncordon a node (admins)

Cordoning a node stops new pods being placed on it; the pods already there keep running. Use the switch on the node's card on the **Map**, in the **Nodes** table, or on the node's panel. Uncordon to accept new pods again. A cordoned node is marked **Cordoned** everywhere.

> **Note:** BastionSSH does not drain nodes (evict their pods). Cordon first, then move workloads with scale or restart, or drain with your usual tools.

## CronJobs

A CronJob's panel shows its schedule and lets you:

- **Suspend** it — no new runs start until it is resumed; a run already going carries on;
- **Resume** it — runs start again at the next scheduled time. Missed runs are not made up beyond what the CronJob's own policy allows;
- **Run now…** — creates a Job from the CronJob's template, owned by the CronJob, named `<cronjob>-manual-<random>`.

## Audit and safety

Every action is recorded in the [audit log](/docs/monitoring/audit-log) with the cluster, namespace, kind, name and the before/after of what changed. An object already in the requested state is left alone. A rollback is guarded so it fails rather than overwrite a Deployment someone changed since you opened it.

The AI assistant never performs Kubernetes actions; it points you to these buttons instead.
