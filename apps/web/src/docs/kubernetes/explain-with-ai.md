---
title: Explain with AI
section: kubernetes
order: 70
summary: Ask your AI provider to explain a Kubernetes object in plain language, see exactly what was sent, and let the AI assistant read clusters without ever changing them.
keywords: [kubernetes, ai, explain, assistant, llm, openai, claude, ollama, redaction, kube_describe, kube_pod_logs, kube_events]
---

The built-in [diagnoses](/docs/kubernetes/diagnoses-and-attention) cover the common problems with fixed rules. When you want a second opinion, or the problem is not one the rules know, **Explain** sends the object and its context to your organization's AI provider and shows a plain-language answer.

The AI only explains. It never changes the cluster — fixing stays with the [guided actions](/docs/kubernetes/guided-actions).

## Before you start

- Your organization needs an AI provider (OpenAI, Anthropic, or a local OpenAI-compatible model) **marked as the default**. See [AI assistant](/docs/ai/ai-assistant). Explain always uses the default provider, and without one it fails with "No AI provider configured".
- A provider added under **Settings** is not marked as the default, and the form has no option for it. Mark one through the API with `PATCH /api/ai/providers/<id>` and the body `{"isDefault": true}` (needs **manage** on the AI Assistant module). Editing the provider in Settings later keeps the mark.
- You need to be able to **operate** where the object lives: operators and up, or a member whose custom role lets them operate in that namespace (or on the whole cluster, for cluster-wide objects such as nodes).
- You need access to the **AI Assistant** module. Members without it do not see the button.

## Explain an object

1. Open any object's panel on a cluster — a pod, Deployment, Service, node, claim and so on.
2. Click **Explain**.
3. A dialog opens and the answer streams in. It has three parts:
   - a one-line **headline** of what is going on (or that it looks healthy);
   - the **most likely cause**, pointing at the evidence — an event, an exit code, a log line;
   - **what to do next**, as short steps, preferring BastionSSH's buttons (scale, restart rollout, roll back, delete pod, cordon) and the logs view over commands.

The answer is kept short — about 250 words at most.

## What is sent to the AI provider

The dialog always ends with a line saying exactly what left BastionSSH, for example:

> Sent to OpenAI: the Deployment with Secret values removed, the status of 2 pods with problems, 14 events, the last 60 log lines.

In detail:

| Sent | Limit |
| --- | --- |
| The object itself, with Secret values removed and the `last-applied-configuration` annotation dropped | About 24,000 characters |
| Recent events about the object (and about its troubled pods) | Up to 30 |
| For a workload, the state of its troubled pods | Up to 5 pods |
| For a crashing container, the last log lines of its **previous** run (the run that crashed); otherwise of the current run | Up to 60 lines / 8,000 characters, and only when you may read logs |

Secret values never leave the cluster view: they are replaced with `••••` before anything is sent, and the AI is told not to ask for them.

> **Warning:** Log lines are sent as the container printed them — they are not redacted. If your logs may contain tokens or personal data, and your AI provider is a third-party service, weigh that before using Explain on a crashing pod. A local model (Ollama, LM Studio, vLLM…) keeps everything on your network.

## Limits and audit

- Each Explain is recorded in the [audit log](/docs/monitoring/audit-log) as `kube.ai_explain`, with the object, the provider and **how much** was sent (number of events, pods and log lines) — never the content.
- You can run up to 10 explanations a minute.
- The answer streams over a live connection; if you lose access to the cluster, it stops.

## The AI assistant can read clusters too

In **AI Assistant**, you can ask about your clusters in chat ("why is the checkout deployment in shop unhealthy?"). The assistant has four read-only Kubernetes tools:

| Tool | What it reads |
| --- | --- |
| `kube_list_workloads` | Workloads with their health, and the pods that are failing or pending, with the reason |
| `kube_describe` | One object, redacted |
| `kube_events` | Recent events, optionally for one object (up to 200) |
| `kube_pod_logs` | The last lines of a container's log (at most 500; operators and up) |

These tools follow exactly the same rules as the UI: the clusters and namespaces you can access, the cluster's namespace allowlist, redaction of Secret values, and the operator requirement for logs. Each read is audited as `ai.kube_read`.

The assistant cannot change a cluster. When a fix needs scaling, a restart or a rollback, it points you to the guided buttons on the cluster page.

## Tips

- Explain works best on the object that is actually failing — the pod or Deployment named in **Needs attention** — rather than on a healthy parent.
- If the answer suggests a `kubectl` command, treat it as an example. The equivalent guided action shows its own `kubectl` command under **What this does**.
- The rule-based diagnosis on the panel is instant and free; use Explain when it does not cover your case.
