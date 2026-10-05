---
title: Logs and pod shells
section: kubernetes
order: 60
summary: Inside a pod — its lifecycle, container lanes with CPU and memory, live logs including the previous run, read-only YAML, and recorded shells.
keywords: [kubernetes, pod, logs, previous run, container, shell, exec, yaml, recording, init container, sidecar, oomkilled]
---

Click any pod — a tile on the map, a row in a list, a pod in a replica ring — to open its panel. The panel has up to three tabs: **Overview**, **Logs** and **YAML**. Logs and YAML are for operators and up.

## Overview: where the pod is in its life

The top of the panel draws the pod's **lifecycle** as a strip of steps:

```text
Scheduled → Initialized → Started → Ready
```

**Initialized** means every init container finished; **Started** means every app container is running (or exited cleanly). A step that failed is red, with the cluster's reason, such as "worker: CrashLoopBackOff"; a step still waiting shows why below the strip. If something is wrong, a **What's wrong** section above it explains it in plain words — see [Diagnoses and the attention list](/docs/kubernetes/diagnoses-and-attention).

### Containers as lanes

Below the lifecycle, the pod's containers are drawn as **lanes** in the order they run:

| Lane | Meaning |
| --- | --- |
| Init containers | Run to completion, one after another, before the app starts ("First, in order") |
| Native sidecars | Start before the app and run beside it |
| App containers | The pod's main containers ("Then, side by side") |
| Debug containers | Added later to debug the pod |

Each lane shows:

- the container's state in a word and a colour (for example **Running**, **Running, not ready**, **Waiting for init**, **Not started**);
- how many times it restarted;
- how its previous run ended (for example `OOMKilled`, exit code 137);
- **CPU and memory bars**: live usage against its limit, with a dashed tick at what it requested. Bars turn amber near the limit and red at it.

> **Note:** Live usage needs metrics-server in the cluster. Without it the bars show requests and limits only.

Each lane has its own buttons to open that container's logs or a shell in it.

## Logs (operators and up)

The **Logs** tab streams a container's output live.

1. Pick the **Container** (the panel opens on the one that needs looking at).
2. Use **Follow** to keep the newest output in view, or stop following to read.
3. Click **Previous run** to see what the container printed before its last restart — this is usually where a crash's error is. (It is only offered when the container has restarted.)
4. Type in **Search** to mark and filter matching lines.
5. Choose how much history to load: 100, 500, 2,000 or 10,000 lines.
6. Toggle line wrapping, or **Download** the log as a text file: the last 10,000 lines, up to 32 MiB.

The view keeps the latest 5,000 lines on screen; download the log to read more. When the container stops, the stream ends with "the container stopped; the log ended".

> **Warning:** Logs are exactly what the container printed. They are **not redacted** and often contain tokens, emails or other personal data, which is why they need the operator role.

## YAML (operators and up)

The **YAML** tab shows the object's manifest read-only, with line numbers, **Find**, **Copy** and **Download**. Secret values, and environment values taken from Secrets, are removed. Viewing a Secret's (redacted) YAML is audited.

## Open a shell in a pod

**Open shell** on the pod's Overview (or on a container lane) starts a shell in a running container — `bash` if the container has it, otherwise `sh` — and opens it in BastionSSH's terminal page, like a server shell. It resizes with the window.

Who can open one:

- **Admins and owners** always.
- **Operators** when **Operators can open a shell in pods** is on under **Settings → Kubernetes** (it is on by default).
- Members whose custom role lets them operate in that namespace, under the same switch.

How it works and what is kept:

- The shell runs over the Kubernetes exec WebSocket on the same verified route as everything else — directly, through a server or through an agent. No port is opened on the cluster.
- It is **recorded** when your organization records sessions, and listed under **Recordings** as "Shell in pod" with the cluster, namespace, pod and container. See [Session recordings](/docs/monitoring/session-recordings).
- Opening and closing are **audited** (`kube.exec_start`, `kube.exec_end`), with the exit code.
- It is **closed at once** if the member loses access to the cluster, loses the role, or the org turns off the operators' shell switch.

> **Note:** The cluster's RBAC must allow it too: shells need `create` (and on older clusters `get`) on `pods/exec` for the credential BastionSSH uses. **Test connection** on the cluster shows whether "Open a shell in a pod" is allowed. See [Adding a cluster](/docs/kubernetes/adding-a-cluster).

## Common situations

| You see | Try |
| --- | --- |
| A red tile and "CrashLoopBackOff" | Logs → previous run, and read the last lines |
| `OOMKilled`, exit code 137 | Compare the memory bar with its limit; raise the limit or reduce usage |
| "Running, not ready" | The readiness probe fails — check the app answers its path and port |
| **Started** fails with `ImagePullBackOff` or `ErrImagePull` | The image cannot be downloaded — check the tag and pull secret |
| Stuck at **Scheduled** | No node can take it — see the **Waiting for a node** lane on the map |

When a fix needs a restart, scale or rollback, use the [guided actions](/docs/kubernetes/guided-actions) on the workload's panel.
