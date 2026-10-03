# Kubernetes (Visual) — Design

**Date:** 2026-10-03
**Status:** Approved (2026-10-03). Scope: a focused Kubernetes slice, **understood visually rather than through CLI commands**. The user accepted the recommendations in §13 ("go with your recommendations and implement").

## 1. Goal

Let someone who does not know `kubectl` look at a cluster and immediately understand **what is running, how it is connected, what is unhealthy and why** — and fix the common problems with guided buttons instead of commands. Power users still get logs, a shell, and a read-only YAML view, but nothing in the core flows requires typing a command.

| # | Phase | Outcome |
| --- | --- | --- |
| K1 | **Connect & see** | Add a cluster; live **cluster map** (nodes with their pods as coloured tiles); namespaces; workload lists with health; read-only details. |
| K2 | **Understand** | **App topology graph** (Ingress → Service → Workload → Pods, with config/storage links); **plain-language problem explanations**; events timeline; "needs attention" list. |
| K3 | **Act (guided)** | Scale with a slider, restart a rollout, roll back from a revision timeline, delete a stuck pod, cordon/uncordon — each with a preview of what will happen. |
| K4 | **Inside pods** | Logs (live, multi-container, previous crash), shell into a container (recorded), resource usage vs requests/limits. |
| K5 | **Integrations** | AI "Explain this" and read-only AI tools, cluster health alerts, fleet overview across clusters. |

Out of scope (each its own spec): creating/editing arbitrary resources or YAML, Helm, CRD-specific UIs (beyond generic read-only listing), cluster provisioning, node drain, network policy editing, multi-cluster deployments, GitOps.

## 2. Assumptions and decisions

1. **The visual model is the product.** Every screen answers a question ("Is my app healthy?", "Why is this pod restarting?", "What talks to what?") with a picture first and detail on demand. Raw YAML is a secondary, read-only tab.
2. **Every action shows its equivalent command** in a collapsible "What this does" panel (e.g. `kubectl rollout restart deployment/web -n shop`) — for learning and auditing, never required.
3. **Talk to the Kubernetes API directly over HTTPS, no `kubectl` and no `@kubernetes/client-node`.** A small typed client over Node `https` with a custom socket, so the connection can run through the existing tunnels (assumption 4). Responses are typed by a hand-maintained subset of the core API types (`v1`, `apps/v1`, `networking.k8s.io/v1`, `batch/v1`, `metrics.k8s.io/v1beta1`).
4. **Reaching the API server** — three modes per cluster:
   - **Direct:** the app connects to the API URL (SSRF-checked with the existing `assertSafeHost`, private ranges allowed as for servers).
   - **Through a managed server:** an SSH connection to that server (via `sshConnectConfig` + `connectSsh`, so host keys, jump hosts and agents all apply) opens a `forwardOut` to the API host:port. Typical for private clusters: tunnel through a control-plane node or bastion already in BastionSSH.
   - **Through a connectivity agent:** only when the agent runs on a control-plane node (the agent dials only its own loopback); the admin adds the API port (usually 6443) to `BASTION_ALLOWED_PORTS`.
5. **TLS is always verified** against the cluster CA from the kubeconfig (or the system store), with SNI set to the API hostname even through tunnels. `insecure-skip-tls-verify` is refused.
6. **Credentials:** a bearer token (service account) or a client certificate/key, stored with `vault.encrypt`. Kubeconfig **exec plugins and auth-provider entries are refused** (they would run arbitrary programs on the app host); the docs show how to create a least-privilege service account token for EKS/GKE/AKS/k3s/kind instead.
7. **Two permission layers.** BastionSSH roles gate what the UI offers (§7); the cluster credential bounds what is possible. Optional **impersonation**: if the credential may impersonate, each request carries `Impersonate-User: bastion:<email>` and `Impersonate-Group: bastion:<role>` so Kubernetes RBAC and audit logs see the real person. Off by default.
8. **Secrets are never displayed.** `Secret` objects show names, types and keys only; `data`/`stringData` values are stripped server-side before anything reaches the browser or the AI. Env values that come from `secretKeyRef` show the reference, not the value. ConfigMap values are shown (they are not secret by contract) but can be hidden per org.
9. **Live by watching, not polling.** The server keeps one watch per (cluster, resource kind, namespace scope) that at least one browser is viewing, maintains an in-memory cache (informer-style, resuming from `resourceVersion`, relisting on `410 Gone`), and fans out changes over SSE. Watches stop 2 minutes after the last viewer leaves.
10. **Reuse from Docker:** SSE conventions and per-user stream caps (`docker/sse.ts` pattern), the permission-matrix pattern, the exec terminal + recording machinery, redaction helpers, fleet fan-out. Pod exec uses the Kubernetes exec subresource over WebSocket (`v5.channel.k8s.io`, falling back to `v4`).
11. **Graph rendering:** `@xyflow/react` (React Flow) for interactive nodes/edges and `elkjs` for automatic layered layout — actively maintained (React Flow is MIT, elkjs EPL-2.0; elkjs loads only in the lazily loaded graph chunk). Charts stay hand-rolled SVG like the Docker stats chart.
12. **Next migration is 0022.**

## 3. Data model (migration `0022_kubernetes`)

`kube_clusters`: `id`, `org_id`, `name`, `api_url`, `connect_via` (`'direct' | 'server' | 'agent'`), `via_server_id` (FK servers, null), `via_agent_id` (FK agents, null), `ca_data` (PEM, null = system store), `auth_type` (`'token' | 'cert'`), `encrypted_credential`, `impersonate` (bool, default 0), `default_namespace`, `namespaces_allowlist` (JSON, null = all), `last_status`, `last_error`, `last_checked_at`, `server_version`, `created_by`, `created_at`, `updated_at`.

`member_cluster_access`: like `member_server_access` (org_id, user_id, cluster_id, expires_at, granted_by) so restricted members and time-limited access work for clusters too.

`organizations.kube_settings` (JSON): `{ operatorsCanExec: true, operatorsCanDeletePods: true, operatorsCanScale: true, showConfigMapValues: true, clusterAlerts: false }`.

## 4. Server side

### 4.1 Modules (`apps/server/src/kube/`)

| File | Responsibility |
| --- | --- |
| `kubeconfig.ts` | Parse an uploaded kubeconfig (YAML), pick a context, extract server/CA/token/cert; reject exec/auth-provider/insecure entries with clear messages. |
| `transport.ts` | Socket to the API server: direct TCP, SSH `forwardOut` through a managed server, or agent tunnel; then `tls.connect` with CA + SNI. |
| `client.ts` | Typed `get/list/watch/patch/delete/exec/logs` over `https.request` with a custom Agent; impersonation headers; API discovery (`/version`, `/apis`). |
| `cache.ts` | Per-cluster watch cache with viewer refcounts, resync, 410 handling, memory cap per cluster. |
| `graph.ts` | Builds the topology graph (§5.2) from cached objects. |
| `health.ts` | Health status per object and plain-language diagnoses (§5.4). |
| `redact.ts` | Secret/env stripping. |
| `actions.ts` | Guided actions (§6) as minimal, well-defined patches. |
| `metrics.ts` | Optional `metrics.k8s.io` reads (nodes, pods); feature-detected. |
| `permissions.ts` | §7 matrix, shared with the web like Docker's. |

### 4.2 Routes (`/api/kube/clusters/...`, all `requireAuth` + cluster access → 404)

- Clusters: `GET /`, `POST /` (admin; kubeconfig upload or fields), `PATCH /:id`, `DELETE /:id`, `POST /:id/test` (reachability → TLS → auth → `/version` → `SelfSubjectRulesReview` summary of what the credential can do, shown in the UI).
- Views (JSON snapshot + SSE stream variants): `GET /:id/overview` (cluster map data), `GET /:id/namespaces`, `GET /:id/graph?namespace=` (topology), `GET /:id/workloads?namespace=&kind=`, `GET /:id/objects/:kind/:ns/:name` (redacted detail, related objects, events, health diagnosis), `GET /:id/events?namespace=&since=`, `GET /:id/attention` (problems list), `GET /:id/stream?view=…` (SSE change feed for the current view).
- Pods: `GET /:id/pods/:ns/:name/logs?container=&previous=&follow=&tail=` (SSE), `POST /:id/pods/:ns/:name/exec` (terminal session, recorded).
- Actions (§6): `POST /:id/actions/{scale,restart,rollback,delete-pod,cordon,uncordon,suspend-cronjob,trigger-cronjob}`.
- Fleet: `GET /api/kube/overview` — health summary across accessible clusters.

## 5. Visual design (the core of this spec)

### 5.1 Cluster map (K1)

A grid of **node cards**. Each card: name, role badge (control-plane/worker), Ready/NotReady, CPU and memory as bars (requests and, when metrics exist, live usage), and the node's **pods as small square tiles** coloured by status: green running/ready, amber pending/starting, red failing (CrashLoopBackOff, Error, OOMKilled), grey completed, purple terminating. Hover a tile → pod name, namespace, restarts; click → pod panel. A namespace filter dims tiles outside it. Unschedulable pods appear in a separate "Waiting for a node" lane with the reason.

### 5.2 App topology graph (K2)

Per namespace (or a selected app label), an auto-laid-out left-to-right graph:

`Ingress` → `Service` → `Deployment / StatefulSet / DaemonSet / CronJob→Job` → `Pods` (collapsed into a replica ring showing ready/desired, expandable), with side links to `ConfigMap`, `Secret` (name only), `PersistentVolumeClaim` → `PersistentVolume`, and `HorizontalPodAutoscaler`.

- Edges come from real relationships: Ingress rules → Service names; Service selectors → Pod labels (drawn to the owning workload); ownerReferences (Pod → ReplicaSet → Deployment); volume and env references; HPA `scaleTargetRef`.
- Node colour = health (§5.4); a red badge with the count of problems; edges that lead nowhere (Service with no matching pods, Ingress to a missing Service) are drawn dashed red — the most common "why is my app down" causes become visible.
- Live: watch events animate replicas changing, pods appearing/disappearing.
- Click a node → side panel with the plain-language summary, key facts, related events, and the guided actions allowed for that object.

### 5.3 Workload & pod views (K2/K4)

- **Rollout timeline:** ReplicaSet revisions as a horizontal timeline (image tag changes, when, by which change-cause annotation), with the current revision highlighted and desired/ready/updated/available replicas as a stacked bar during a rollout. "Roll back to this revision" button on past entries.
- **Pod panel:** containers as lanes (init → app → sidecars) with state badges, restart counts and last termination reason; a lifecycle strip built from pod conditions and events (Scheduled → Pulled → Started → Ready); requests/limits vs live usage bars; logs tab; "Open shell".
- **Events timeline:** grouped by object, newest first, warnings highlighted, repeated events collapsed with a count ("Back-off restarting failed container ×37 in 20 min").

### 5.4 Plain-language health and diagnoses (K2)

A rule-based explainer (no AI needed) maps known states to a headline, likely cause, and next step, each linked to the evidence:

| Signal | Headline shown |
| --- | --- |
| `CrashLoopBackOff` + last exit code/logs tail | "The app starts and crashes repeatedly (exit code 1). Check its logs — last lines shown." |
| `ImagePullBackOff` / `ErrImagePull` | "The image `shop/web:1.4.2` can't be downloaded — wrong tag, private registry without credentials, or registry unreachable." |
| `OOMKilled` | "The container ran out of memory (limit 256Mi). Raise the limit or reduce usage." |
| `Pending` + `FailedScheduling` | "No node has room: needs 2 CPU, largest free is 0.5 CPU." / "No node matches its node selector or tolerations." |
| Readiness probe failing | "Running but not ready — the readiness check `/healthz` fails, so it receives no traffic." |
| Service with no endpoints | "This Service selects `app=web` but no ready pods match — traffic goes nowhere." |
| PVC `Pending` | "Storage was requested but not provisioned — no StorageClass `fast` or no capacity." |
| Node `NotReady` / pressure conditions | "Node is unreachable or under memory/disk pressure; its pods may be evicted." |
| Deployment stuck (`ProgressDeadlineExceeded`) | "The new version never became ready; the previous version is still serving." |

The **"Needs attention"** list on the cluster page ranks these across namespaces. An optional **AI "Explain"** button (K5) sends the redacted object, related events and a capped log tail to the configured AI provider for a narrative explanation.

### 5.5 Navigation

Sidebar **Kubernetes** → cluster list (health dot per cluster) → cluster page with tabs **Map · Apps (graph) · Workloads · Events · Nodes · Storage · Config**; a namespace picker persists per user. Every object has a stable URL for sharing.

## 6. Guided actions (K3)

Each action opens a panel with a preview, the equivalent command (collapsed), and a confirm button naming the object. All are audited with cluster, namespace, kind, name, before/after.

| Action | UI | Implementation |
| --- | --- | --- |
| Scale | Slider + number, shows current → new replica rings; warns if an HPA controls it | `PATCH …/scale` |
| Restart rollout | Button; preview "pods are replaced one by one, no downtime if replicas > 1" | Patch `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]` |
| Roll back | Pick a revision on the timeline; diff of image/env names shown | Patch the Deployment template to the ReplicaSet's template (what `kubectl rollout undo` does) |
| Delete pod | "Restart this pod" when it has an owner (it will be recreated); stronger warning for bare pods | `DELETE pod` |
| Cordon / uncordon | Node card toggle; explains no new pods will be scheduled | Patch `spec.unschedulable` |
| CronJob suspend / trigger now | Toggle / button | Patch `spec.suspend` / create a Job from the template |

UI actions do not go through AI command approval (same reasoning as Docker); AI never performs actions in this spec.

## 7. Permissions

| Capability | viewer | operator | admin/owner |
| --- | --- | --- | --- |
| Map, graph, workloads, events, health, redacted details | ✓ | ✓ | ✓ |
| Logs | — | ✓ | ✓ |
| Read-only YAML (redacted) | — | ✓ | ✓ |
| Scale, restart rollout, CronJob trigger/suspend | — | ✓ if `operatorsCanScale` | ✓ |
| Delete pod | — | ✓ if `operatorsCanDeletePods` | ✓ |
| Roll back, cordon/uncordon | — | — | ✓ |
| Shell into a pod | — | ✓ if `operatorsCanExec` | ✓ |
| Add/edit/remove clusters, credentials, impersonation | — | — | ✓ |

Cluster access follows the per-server model: restricted members see only granted clusters (404 otherwise), time-limited grants expire, and `revokeLiveAccess` ends their streams and shells. The org-level namespace allowlist on a cluster limits what anyone can see.

## 8. Security

1. TLS verification always on; CA pinned from kubeconfig; SNI preserved through tunnels.
2. No exec/auth-provider kubeconfig entries; no `kubectl` on the app host.
3. Credentials encrypted with the vault; never returned to the browser after save (shown as "token ending …abcd").
4. Secret values stripped server-side everywhere (details, YAML view, AI context, logs are not touched — logs are operator+ like Docker).
5. Names/namespaces validated against Kubernetes DNS-1123 rules before building URLs; kinds from a fixed allowlist.
6. Watches and SSE streams counted against the per-user cap; per-cluster cache memory cap with eviction of the least-viewed scope.
7. Audit: cluster add/edit/remove/test, every action, shell start/end, YAML views of Secrets (names only, but still audited), impersonation on/off.
8. Least-privilege guidance in the docs: a read-only ClusterRole for viewing plus a separate Role for the guided actions per namespace.

## 9. Testing

- **Unit:** kubeconfig parsing and rejection rules; graph building from fixture objects (selectors, ownerReferences, dangling edges); every diagnosis rule in §5.4; redaction; action patch bodies; DNS-1123 validation.
- **Fake API server:** an in-process HTTPS server with a test CA serving list/watch (including `410 Gone` resync), logs streaming, exec WebSocket, and patch endpoints; reached directly and through mocked SSH `forwardOut`.
- **Route tests:** role/settings matrix, cluster access 404s, time-limited cluster grants, revocation closing streams.
- **Integration (env-gated, throwaway):** `k3d` or `kind` cluster on unusual ports with a sample app (deployment + service + ingress + a crash-looping pod + an unschedulable pod), reached directly and through an `openssh-server` container; asserts map/graph/diagnoses and runs each guided action.
- **Playwright:** cluster map and topology graph render from a stubbed API (node/edge counts, colours, dashed broken edges), diagnosis panel text, scale slider flow with confirmation.

## 10. Rollout and effort

| Phase | Rough size |
| --- | --- |
| K1 connect, transport, client, cache, cluster map, workload lists | 5–6 days |
| K2 topology graph, diagnoses, events timeline, attention list | 5–6 days |
| K3 guided actions with previews | 2–3 days |
| K4 logs, pod shell + recording, usage bars | 3 days |
| K5 AI explain/tools, cluster alerts, fleet overview | 2–3 days |

Each phase on its own branch, reviewed and merged like Docker. K1+K2 deliver the "visual understanding" goal on their own; K3–K5 can follow.

## 11. Dependencies

- `@xyflow/react` (graph UI), `elkjs` (layout) — web only.
- `yaml` (kubeconfig parsing) — server. Not currently a direct dependency (`js-yaml` is only present transitively), so it is added explicitly.
- No `kubectl`, no `@kubernetes/client-node`.

## 12. Relation to Docker management

Shared: SSE helpers and caps, permission-matrix pattern, exec terminal and recordings, redaction approach, fleet fan-out, diagnose integration (a "Kubernetes API" step reusing DNS/TCP/TLS steps). Different: one cluster is not one server, so clusters are their own objects with their own access grants.

## 13. Decisions (resolved open questions)

1. **Impersonation:** opt-in per cluster, off by default.
2. **Operator defaults:** scale, restart rollout, CronJob trigger/suspend, delete pod and exec allowed (org toggles `operatorsCanScale`, `operatorsCanDeletePods`, `operatorsCanExec`, all default on); rollback and cordon/uncordon admin-only.
3. **ConfigMap values:** shown by default; org switch `showConfigMapValues` hides them.
4. **Cluster alerts:** opt-in per org, default off (`clusterAlerts: false`).
5. **Graph scope:** core kinds only; CRDs listed generically (read-only) without graph nodes.
6. **Read-only YAML:** available to operators and above, with Secret values stripped.
