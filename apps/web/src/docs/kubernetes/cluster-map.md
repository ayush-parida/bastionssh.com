---
title: Cluster map and views
section: kubernetes
order: 20
summary: Read a cluster at a glance — nodes with their pods as coloured tiles, pods waiting for a node, workloads, events, storage, config and the multi-cluster Overview.
keywords: [kubernetes, cluster map, nodes, pods, workloads, events, storage, config, namespace, overview, metrics-server]
---

Once a cluster is added (see [Adding a cluster](/docs/kubernetes/adding-a-cluster)), it appears under **Kubernetes** in the sidebar as a card with a health dot from its last test or use, its Kubernetes version, its API address and its route ("direct", "through *server*", "through agent *name*"). Click a card to open the cluster.

Everything on a cluster's pages updates live while the page is open. Nothing needs `kubectl`, and nothing here changes the cluster.

## The cluster page

Across the top are the cluster's name and health dot, **Diagnose**, a **Who has access** button (admins only) and the **namespace picker**. Below them are seven tabs:

| Tab | What it shows |
| --- | --- |
| **Map** | The **Needs attention** list, then every node with its pods |
| **Apps** | How each app is wired together — see [App topology graph](/docs/kubernetes/app-topology) |
| **Workloads** | Deployments, StatefulSets, DaemonSets, Jobs and CronJobs with their health |
| **Events** | What Kubernetes reported, grouped by object |
| **Nodes** | A table of nodes: status, CPU and memory requested, kubelet version, cordoned or not |
| **Storage** | Volume claims, storage classes and unclaimed volumes |
| **Config** | ConfigMaps and Secrets by name and key name |

### Picking a namespace

The picker defaults to **All namespaces**. Picking one dims or filters everything outside it. The choice is remembered per user and per cluster in your browser. If a cluster has a namespace allowlist, or your access is narrowed to some namespaces, you only see those.

## The map

The **Map** tab draws one card per node. Each card shows:

- the node's name and role, and whether it is **ready** (a not-ready node has a red border) or **cordoned**;
- any **memory, disk or PID pressure** — hover the badge for what it means;
- the pod count against the most it can run;
- **CPU** and **Memory** bars: the wide pale bar is what pods reserved (requests); the thin bar inside is what they really use. Bars turn amber at 75% and red at 90%;
- the node's pods as small tiles.

> **Note:** Live usage needs [metrics-server](https://github.com/kubernetes-sigs/metrics-server) in the cluster. Without it, the map says "live usage needs metrics-server" and the bars show requests only. If the credential cannot read nodes, a card says "Capacity unknown".

### Pod tile colours

| Colour | Meaning |
| --- | --- |
| Green | Running |
| Amber | Pending or starting |
| Red | Failing (CrashLoopBackOff, Error, OOMKilled, image pull errors…) |
| Grey | Completed |
| Purple | Terminating |
| Amber ring | The pod's containers have restarted at least once |

The legend above the cards counts each colour. Hover a tile for the pod's name, namespace, restarts and reason; click it to open the pod's panel (see [Logs and pod shells](/docs/kubernetes/logs-and-pod-shells)).

### Waiting for a node

Pods that no node can take are not drawn on any node. They wait in a separate **Waiting for a node** lane at the top, each with the scheduler's reason — for example "0/3 nodes are available: Insufficient cpu". The [diagnosis](/docs/kubernetes/diagnoses-and-attention) on the pod's panel turns that into plain words.

## Object panels

Clicking any object — a tile, a row, a box in the graph — opens its **panel** over the page. A panel shows health, key facts, labels and what the object is connected to (its owner, the pods it runs or sends traffic to), each a link. Every panel has a stable URL, so you can copy the address bar and share it with a teammate who has access.

Operators and up also get a read-only **YAML** tab, with line numbers and search. Secret values, and environment values taken from Secrets, are never shown. Opening a Secret's (redacted) YAML is recorded in the audit log.

## Workloads

The **Workloads** tab lists Deployments, StatefulSets, DaemonSets, Jobs and CronJobs. Filter by kind with the chips at the top, or search by name. Each row has a health dot and a one-line summary such as "2 of 3 ready", "Completed 1/1" or "Runs 0 3 * * *". Health words are **Healthy**, **Updating**, **Needs a look**, **Failing**, **Suspended**, **Completed** and **Idle**.

## Events

**Events** is the timeline of what Kubernetes reported, grouped by object, with warnings highlighted and repeats collapsed ("Back-off restarting failed container ×37 in 20 min"). Choose how far back to look (**Last hour**, **Last 6 hours**, **Last day** or **Everything kept**), show warnings only, or filter by text.

> **Note:** Kubernetes itself only keeps events for about an hour by default, so older problems may have no events left.

## Storage

**Storage** draws each volume claim as a chain: the workloads that mount it → the claim → the volume holding the data. A chain is green when it has storage, amber while it waits for its first pod (`WaitForFirstConsumer`), and red with the reason when nothing will provision it. Below are the **Storage classes** (which one is the default, and whether data is kept or deleted with the claim) and **Volumes no claim holds** — disks that exist but no app is using.

## Config

**Config** lists **ConfigMaps** and **Secrets** by name and key name only, with the workloads that read each one as files or environment variables. Anything a workload needs that does not exist is called out in red. Objects made by Kubernetes or Helm (the CA bundle, Helm release records, service-account tokens) are hidden unless you tick **Show … made by Kubernetes or Helm**.

ConfigMap values are shown in panels unless an owner or admin turns off **Show ConfigMap values** under **Settings → Kubernetes**. Secret values are never shown, whatever that setting says.

## The Overview page

**Kubernetes → Overview** shows every cluster you can use side by side, with totals at the top (**Clusters answering**, **Nodes ready**, **Pods failing**, **Open alerts**). Each cluster card shows its nodes as small squares (red when not ready), its pods as one bar in the map's colours, its workloads by health, the few things that most need attention (each a link) and any open alerts.

Clusters are asked five at a time, with 10 seconds each, so one that is down shows as a grey card with the reason instead of holding up the page.

## Who sees what

Everyone with access to a cluster sees the map, workloads and details. Restricted members only see clusters granted to them under **Team & Access** (see [Resource grants](/docs/access/resource-grants)), and a member narrowed to some namespaces sees only those — and not which server or agent the cluster is reached through. Revoking access closes a member's live views at once.
