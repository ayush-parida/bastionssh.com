---
title: AI assistant
section: ai
order: 10
summary: Connect your own AI provider and let the assistant run diagnostics, read containers and clusters, and propose changes you approve.
keywords: [ai, assistant, openai, anthropic, claude, ollama, lm studio, llm, chat, approval, tools]
---

BastionSSH has a built-in AI assistant that can look at your servers, containers and Kubernetes clusters on your behalf. You bring your own AI provider: OpenAI, Anthropic, or any OpenAI-compatible model you run yourself. Your API key stays on your BastionSSH instance.

The assistant can read freely, but it cannot change a server without your say-so: any command that might change something waits for you to click **Approve**.

## Adding a provider

Adding, editing and removing providers needs the **manage** level on the AI Assistant module (admins and owners by default).

1. Go to **Settings**.
2. In the **AI Providers** section, click **Add provider**.
3. Fill in the form:

| Field | What to enter |
| --- | --- |
| **Name** | A label people pick from, for example "GPT-4o" or "Local Llama" |
| **Type** | **OpenAI**, **Anthropic**, or **OpenAI-compatible (LM Studio, Ollama…)** |
| **API Key** | The provider's key. For a local server that does not check keys, enter any placeholder |
| **Base URL** | OpenAI-compatible only, for example `http://localhost:11434/v1` for Ollama |
| **Model** | The model name, for example `gpt-4o`, a Claude model name, or `llama3.2` |

4. Click **Save**.

The API key is encrypted at rest and never shown again. When editing, leave **API Key** blank to keep the existing one. You can add several providers; people choose between them in the chat.

> **Note:** "OpenAI-compatible" covers Ollama, LM Studio, llama.cpp's server, vLLM and any other service that speaks the OpenAI chat API. The model must support tool (function) calling for the assistant to run commands.

## Where to use it

- **AI Assistant** in the sidebar opens a full-page chat. Pick a provider in the top-right if there is more than one.
- In a server's terminal (**Servers → a server → Connect**), click **AI** in the toolbar to open the assistant next to the terminal. Here it knows which server you are on and sees the last part of your terminal output, so you can ask "why did that fail?". It offers quick actions such as **CPU & memory**, **Disk usage** and **Recent errors**. Commands in its answers get a button that types them into your terminal and runs them.

Conversations are not saved: they live in your browser tab and are gone when you leave the page.

## What the assistant can do

The assistant works by calling tools. Each tool call shows in the chat with its input and output, so you can see exactly what it did.

| Tool | What it does |
| --- | --- |
| `run_command` | Runs a shell command on a server over SSH (see approvals below) |
| `list_servers` | Lists the servers you can access |
| `list_saved_commands` | Lists saved commands, optionally for one server |
| `docker_list_containers` | Lists containers on a server |
| `docker_container_logs` | Reads the last lines of a container's logs (at most 500) |
| `docker_inspect` | Inspects a container, with environment values hidden |
| `kube_list_workloads` | Lists workloads in a cluster |
| `kube_describe` | Describes a Kubernetes object, with Secret values removed |
| `kube_events` | Reads recent Kubernetes events |
| `kube_pod_logs` | Reads the last lines of a pod's logs (at most 500) |
| `get_recent_audit` | Reads recent audit log entries (only your own unless you have the Audit Log module) |

The assistant cannot change a Kubernetes cluster. It points you to the guided buttons on the cluster page instead (see [Guided actions](/docs/kubernetes/guided-actions)). Docker changes such as `docker restart web` go through `run_command` and need approval like any other change.

## Command approvals

Before running a command, BastionSSH checks whether it is read-only. The check is deliberately strict:

- Commands made only of known read-only programs, such as `df -h`, `ps aux | head` or `journalctl -n 50`, run immediately.
- Anything else waits for you: restarts, installs, edits, deletes, writes to files, `sudo`, command substitution, redirects into files, and any program the checker does not recognise. Most `git` commands also need approval, because repository config can make git run programs.

When a command needs approval, an **Approval needed** card appears with the exact command, the server and SSH user it will run as, the server's host key status, and why it needs approval. Click **Approve** to run it or **Deny** to refuse.

- If nobody decides within **5 minutes**, the command is not run.
- If you close the chat or the connection drops, a pending command is cancelled.
- After a denial or timeout, the assistant is told not to retry the same command.

For more on how the checker decides, see [AI command approval](/docs/security/ai-command-approval).

## Who can use it

The assistant needs the **AI Assistant** module in your role. Built-in operators, admins and owners have it; viewers do not. If your roles do not include it, the page says so and the sidebar link is hidden.

The assistant never gives you more than you already have. Every tool checks your access on its own target:

- `run_command` needs the **operate** level on the server, just like opening a terminal.
- Servers you cannot access are answered as "not found".
- Docker and Kubernetes reads follow the same rules as the UI: logs and inspect need operate.

Read-only API tokens cannot use the chat. If your access changes while a conversation is running, it is stopped with a message saying so.

## What is sent to your provider

Each message you send goes to the provider along with context so the assistant can help:

- the names, `user@host:port` and tags of the servers you can access;
- the names and command text of saved commands you can see, and the names and schedules of cron jobs;
- the names of Kubernetes clusters you can access;
- in the terminal panel, the last few thousand characters of your terminal output;
- the results of every tool the assistant calls, such as command output and logs.

Docker environment values and Kubernetes Secret values are removed before anything is sent. Command output and logs are sent as they are, so they may contain whatever the server printed.

> **Warning:** If your servers handle sensitive data, choose a provider whose data handling you trust, or run a local model with the OpenAI-compatible type so nothing leaves your network.

## Auditing and recordings

Every command the assistant runs is recorded in the audit log (`ai.command_run`), along with each approval (`ai.command_approved`) and denial (`ai.command_denied`). Docker and Kubernetes reads are audited as `ai.docker_read` and `ai.kube_read`. Commands are also recorded as session recordings when recording is on. See [Audit log](/docs/monitoring/audit-log).
