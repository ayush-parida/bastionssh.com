---
title: Diagnoses and the attention list
section: kubernetes
order: 40
summary: Plain-language explanations of what is wrong in a cluster, the ranked Needs attention list, and opt-in cluster alerts.
keywords: [kubernetes, diagnosis, needs attention, crashloopbackoff, oomkilled, imagepullbackoff, pending, readiness, alerts, troubleshooting]
---

Kubernetes reports problems in its own vocabulary — `CrashLoopBackOff`, `FailedScheduling`, `ProgressDeadlineExceeded`. BastionSSH turns the common ones into a sentence you can act on: **what is wrong**, the **likely cause**, the **next step**, and the **evidence** it rests on.

These diagnoses are rules over what the cluster reports. They do not use AI, they cost nothing, and they update live. For a free-form explanation from your AI provider, see [Explain with AI](/docs/kubernetes/explain-with-ai).

## Where diagnoses appear

- **On an object's panel** — click any pod, workload, Service, claim or node. The panel opens with a **What's wrong** section when something is.
- **In the Needs attention list** — at the top of a cluster's **Map** tab, covering the whole cluster (or the namespace you picked).
- **On the Overview page** — **Kubernetes → Overview** lists the few things that most need attention on each cluster.

## What a diagnosis looks like

Each diagnosis card has:

1. **A headline** — for example "The app starts and crashes repeatedly (exit code 1)."
2. **The likely cause** — for example "Container `api` exited with code 1; it has restarted 14 times and Kubernetes now waits longer before each new start."
3. **The next step** — for example "Check its logs — last lines shown."
4. **Evidence** — the objects, events and facts it rests on. Objects are links to their panels; events show how often they repeated.

For a crash loop, operators and up also see the last lines the container printed before it crashed, right in the card.

## The problems BastionSSH recognises

A pod is checked against these rules in order, and the first match wins, so each pod has at most one problem:

| Problem | Example headline | Typical fix |
| --- | --- | --- |
| Image cannot be pulled | "The image `shop/api:v2` can't be downloaded — wrong tag, private registry without credentials, or registry unreachable." | Fix the tag, or add an image pull secret |
| Out of memory | "The container ran out of memory (limit 256Mi)." | Raise the limit or reduce usage |
| Crash loop | "The app starts and crashes repeatedly (exit code 1)." | Read the previous run's logs |
| No room on any node | "No node has room: needs 2 CPU, largest free is 0.5 CPU." | Lower the request, scale other workloads down, or add a node |
| Placement rules | "No node matches its node selector or tolerations." | Check nodeSelector, affinity and tolerations against node labels and taints |
| Other scheduling | "No node can take this pod yet." | Follow the scheduler's message |
| Readiness check failing | "Running but not ready — the readiness check … fails, so it receives no traffic." | Make the app answer the probe, or fix the probe's path and port |

Other objects are checked too:

| Object | Problem |
| --- | --- |
| Service | "This Service selects `app=web` but no ready pods match — traffic goes nowhere." |
| Volume claim | Storage was requested but not provisioned — no matching StorageClass, no default, or no capacity |
| Node | Not ready, or under memory, disk or PID pressure — its pods may be evicted |
| Deployment | The rollout passed its deadline: the new version never became ready (and whether the previous one is still serving) |

> **Note:** Diagnoses only read what the cluster's credential can see, and they never show Secret values — at most a Secret's name.

## The Needs attention list

The **Map** tab of each cluster opens with **Needs attention**: every problem across namespaces (or only the picked one), ranked:

1. critical problems first,
2. then the ones hitting the most pods,
3. then the newest.

A workload whose replicas all fail the same way is **one line**, not ten. The first five are shown; click **Show all** for the rest. When the cluster is healthy the list collapses to a single line: "Nothing needs attention."

Click the subject of any card to open its panel, where you can read logs or use a [guided action](/docs/kubernetes/guided-actions) to fix it.

## Events behind the diagnosis

Many diagnoses rest on Kubernetes events. The **Events** tab shows them as a timeline grouped by object, warnings highlighted and repeats collapsed. An object's panel also lists its own recent events. Kubernetes keeps events for about an hour by default, so a problem that started earlier may have none left.

## Cluster alerts

Diagnoses tell you what is wrong when you look. **Cluster alerts** tell you when you are not looking. They are **off by default**.

To turn them on:

1. Open **Settings** and find the **Kubernetes** section (owners and admins).
2. Switch on **Alert on cluster problems**.

After each health-check sweep, BastionSSH then reads each cluster and raises an alert through your [notification channels](/docs/monitoring/notification-channels) when:

| Alert | Fires when |
| --- | --- |
| Cluster unreachable | The cluster could not be read three sweeps in a row |
| Node not ready | A node's Ready condition is not true |
| Workload unavailable | A Deployment, StatefulSet or DaemonSet has no ready replicas (or its rollout passed its deadline) |
| Pods crash-looping | Pods are in CrashLoopBackOff, or restarted three or more times within 10 minutes |
| Pods pending | Pods have stayed pending for more than 10 minutes |

Pod alerts are grouped by the workload that owns them, so ten crashing replicas are one alert. Each alert gets its own paging incident (PagerDuty, Opsgenie) and is resolved when the problem clears. An alert that reopens within 30 minutes of resolving — a flapping pod — reopens quietly. At most 25 alerts are kept open per cluster, critical first, so a broken cluster cannot flood a channel. The cluster's namespace allowlist applies.

> **Note:** Cluster alert state is kept in memory. After BastionSSH restarts, alerts that are still firing are announced again under the same incident key, so paging tools keep one incident each.

See [Health monitoring](/docs/monitoring/health-monitoring) for how the sweep is scheduled.
