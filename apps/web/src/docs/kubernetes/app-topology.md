---
title: App topology graph
section: kubernetes
order: 30
summary: The Apps tab draws how each app is wired — Ingress, Service, workload, pods, config and storage — and marks links that lead nowhere in dashed red.
keywords: [kubernetes, topology, graph, apps, ingress, service, selector, configmap, secret, pvc, hpa, broken link]
---

The **Apps** tab answers "how is this app put together, and where is it broken?" without reading a single manifest. It draws a graph of the objects in the picked namespace (or all of them), left to right, joined by lines that each stand for a real relationship in the cluster.

Open it from **Kubernetes → a cluster → Apps**.

## What the graph shows

Objects flow left to right in the order traffic and ownership go:

```text
Ingress → Service → Deployment / StatefulSet / DaemonSet / CronJob → (Job) → Pods
```

Alongside the workloads, the graph draws what they use:

- **ConfigMaps** and **Secrets** they read as files or environment variables (Secrets by name only — their values never reach BastionSSH's browser views);
- **Volume claims** they mount, and the **PersistentVolume** each claim is bound to;
- **HorizontalPodAutoscalers** that scale them.

A ReplicaSet is folded into its Deployment, so a Deployment links straight to its pods.

### Where the lines come from

Every line is a relationship Kubernetes itself records — nothing is guessed from names:

| Line | Comes from |
| --- | --- |
| Ingress → Service | The Ingress's rules and default backend |
| Service → workload | The Service's selector matching the pods' labels (also matched against a workload's pod template, so a Deployment scaled to zero still shows what it would serve) |
| Workload → pods, CronJob → Job | `ownerReferences` |
| Workload → ConfigMap / Secret / claim | Volumes, `envFrom` and `env.valueFrom` in the pod template and running pods |
| Claim → volume | The claim's `volumeName` |
| Autoscaler → workload | The HPA's `scaleTargetRef` |

Hover a line for what it means, such as "Sends traffic to the pods labelled `app=web`".

## Reading the colours

Boxes are coloured by health, with a legend above the graph:

| Colour | Label |
| --- | --- |
| Green | Healthy |
| Blue | Updating (a rollout in progress) |
| Amber | Needs a look |
| Red | Failing |
| Grey | Idle |
| Red dashed box | Does not exist (something refers to it, but it is not in the cluster) |

A box with problems carries a red badge counting them.

### Replica rings

Instead of drawing every pod, each workload has one **ring** of its pods showing ready / desired (for example 2/3), split into the map's pod colours: green running, amber pending, red failing, grey completed, purple terminating. Click the ring to expand it and see each pod; click again to collapse. This keeps a namespace with hundreds of pods readable — a group lists up to 300 pods (problems first), while the ring's counts still cover every pod.

## Links that lead nowhere

A line drawn **dashed red** leads nowhere. Common cases:

- an Ingress that sends traffic to a Service that does not exist;
- a Service whose selector matches no pod — "traffic goes nowhere";
- pods that need a ConfigMap or Secret that does not exist — "they cannot start";
- a claim bound to a PersistentVolume that no longer exists;
- an autoscaler that scales a workload that does not exist.

The counts above the graph say how many objects and links there are, and how many are broken. A box below the graph lists every broken link with its reason in words, so you can read them without hunting through the picture.

## Narrowing the picture

Big namespaces can be busy. To focus:

1. Pick a namespace with the namespace picker at the top of the cluster page.
2. If the namespace holds more than one app, pick one in the **All apps** dropdown above the graph.

Use the zoom controls in the corner to zoom and fit; graphs with more than 30 objects also get a minimap for panning.

## Opening an object

Click any box to open its panel. The panel leads with what is wrong in plain words, the likely cause and the next step — see [Diagnoses and the attention list](/docs/kubernetes/diagnoses-and-attention). From there you can read logs, open YAML (operators and up), or take a [guided action](/docs/kubernetes/guided-actions).

> **Note:** The graph updates live while the page is open, and it is built only from what the cluster reports — no AI is involved. If the cluster's credential cannot list a kind of object (for example Ingresses), those boxes and lines are simply missing.
