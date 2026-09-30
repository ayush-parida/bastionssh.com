# Docker Management — Design

**Date:** 2026-09-30
**Status:** Approved (2026-09-30). The user accepted the recommendations in §12 ("go with your recommendations and implement").

## 1. Goal

Manage Docker on the servers BastionSSH already manages, from the same UI, with the same access rules, audit, recording and host-key guarantees — without installing anything new on the server and without opening any new port.

| # | Phase | Outcome |
| --- | --- | --- |
| D1 | **Read** | Per server: containers, images, volumes, networks, with live status; container logs (follow), stats, inspect (secrets redacted). |
| D2 | **Act** | Start, stop, restart, kill, pause/unpause, remove containers; pull and remove images; prune. Confirmations, audit, role gates. |
| D3 | **Exec** | A shell inside a container in the existing terminal UI, recorded like any other session. |
| D4 | **Compose** | Compose projects discovered from labels; status per service; `up -d`, `down`, `pull`, `restart`, logs per project. |
| D5 | **Integrations** | AI read-only tools, container health alerts through existing monitoring/notification channels, fleet view across servers. |

Out of scope (each its own spec): Kubernetes, Docker Swarm services/stacks, building images, registries management/credentials UI, editing compose files in the browser, Podman-specific features beyond the Docker-compatible API.

## 2. Assumptions and decisions

1. **Transport is the existing SSH connection.** The app opens a direct-streamlocal channel (`client.openssh_forwardOutStreamLocal(socketPath)`, supported by ssh2 1.17) to the Docker socket on the server and speaks the Docker Engine HTTP API over it. Every connection is made through `sshConnectConfig` + `connectSsh`, so host-key verification, jump hosts and connectivity agents work unchanged (an agent carries the SSH connection; the socket forward happens inside SSH on the target).
2. **Fallback when stream-local forwarding is disabled** (`AllowStreamLocalForwarding no` in sshd): run `docker system dial-stdio` through an exec channel, which pipes the same API over stdin/stdout (Docker CLI ≥ 18.09). The transport is chosen per server by probing once and cached (§4.2).
3. **No new dependency for the API client.** Node's `http.request` with an `Agent` whose `createConnection` returns a fresh forwarded stream per HTTP connection. `dockerode`/`docker-modem` are not used: their SSH mode opens its own ssh2 connection, which would bypass host-key verification and jump/agent routing.
4. **Socket path:** default `/var/run/docker.sock`; per-server override for rootless Docker (`/run/user/<uid>/docker.sock`) or Podman's compatible socket (`/run/podman/podman.sock`). Auto-detect tries the default, then `$XDG_RUNTIME_DIR/docker.sock` via `echo $XDG_RUNTIME_DIR` exec, and records what worked.
5. **Access to the Docker socket is root-equivalent.** The UI says so on the server's Docker tab. The feature does not try to be a security boundary *inside* the server; it gates who in the org may use it (§6).
6. **Per-server access applies unchanged.** Anyone who cannot access a server gets 404 for its Docker endpoints, like every other server route.
7. **Secrets in `inspect` are redacted by default.** Container `Env` values, and `Config.Env` in images, are replaced by `KEY=••••` unless an admin reveals them with passkey step-up (audited). Labels are shown as-is.
8. **Compose actions use the CLI, not the API.** The Engine API has no Compose endpoints. Projects are *discovered* from container labels (`com.docker.compose.project`, `…project.working_dir`, `…project.config_files`) via the API; *actions* run `docker compose -p <project> -f <files> <cmd>` in the working directory through `execOnServer` with arguments passed safely (no shell interpolation of user input — §7.4).
9. **UI-initiated actions are not routed through AI command approval.** They are explicit user actions with their own confirmation dialogs and role gates. The AI gets read-only Docker tools; anything mutating it proposes still goes through `run_command` and approval (the classifier already treats `docker` subcommands conservatively).
10. **Recording:** container exec sessions are recorded with the existing asciicast recorder and org recording settings; each recording notes the container id/name.
11. **Connections are pooled per (org, server, user)** like SFTP, idle-closed after 2 minutes, and evicted by `revokeLiveAccess` (suspension, access change, sign-out everywhere).
12. **Next migration number is 0021.**

## 3. Data model (migration `0021_docker`)

`servers`:
- `docker_mode` text not null default `'auto'` — `'auto' | 'off'`. `off` hides the tab and refuses Docker routes (400).
- `docker_socket_path` text null — override; null means auto-detect.
- `docker_transport` text null — cached probe result: `'streamlocal' | 'dial-stdio'`.
- `docker_detected_at`, `docker_version`, `docker_api_version` text null — last successful probe.

`organizations`:
- `docker_settings` text (JSON) null — `{ operatorsCanExec: true, operatorsCanRemove: false, allowPrune: true }` (§6).

No table for containers: state is always read live from the daemon. Audit rows and recordings carry container identity in metadata.

## 4. Server side

### 4.1 Module layout (`apps/server/src/docker/`)

| File | Responsibility |
| --- | --- |
| `transport.ts` | Open a byte stream to the daemon for a server: streamlocal or dial-stdio over a pooled SSH connection. |
| `pool.ts` | Per (org, server, user) SSH connection pool; idle timeout; eviction hooks registered with `auth/revoke.ts`. |
| `client.ts` | Minimal Engine API client over `http.request` + custom Agent; JSON calls, streaming calls (logs, stats, events), hijacked calls (exec attach). API version negotiated from `/version`, pinned per server. |
| `demux.ts` | Split Docker's multiplexed stdout/stderr stream (8-byte frame header) for non-TTY logs/exec. |
| `redact.ts` | Env/secret redaction for inspect payloads. |
| `compose.ts` | Project discovery from labels; argument building for `docker compose` actions. |
| `errors.ts` | Map daemon/transport errors to HTTP (404 no such container, 409 conflict, 403 permission denied on socket, 502 transport, 504 timeout, 400 docker off/not installed). |

### 4.2 Probe and detection

`POST /api/docker/servers/:id/probe` (admin) and lazily on first use:
1. Try streamlocal on the configured/default socket → `GET /_ping`.
2. On `open failed (administratively prohibited)` → try `dial-stdio`.
3. On socket not found → try the rootless path from `$XDG_RUNTIME_DIR`.
4. Record transport, socket path, `/version` (engine + API version) in `servers`.
5. Clear diagnosis on failure: *Docker not installed*, *permission denied on socket* (user not in `docker` group — show the `usermod -aG docker <user>` hint), *forwarding disabled and CLI missing*.

The existing **Diagnose** flow gains a "Docker" step when `docker_mode = 'auto'`.

### 4.3 Routes (`/api/docker/servers/:id/...`, all behind `requireAuth` + per-server access)

Read (D1):
- `GET containers?all=1` · `GET containers/:cid` (redacted inspect) · `GET containers/:cid/logs?follow&tail&since&timestamps` (SSE) · `GET containers/:cid/stats` (SSE, one sample per second, stops on disconnect) · `GET containers/:cid/top`
- `GET images` · `GET images/:iid` · `GET volumes` · `GET networks` · `GET info` (engine info, disk usage via `/system/df`)
- `GET events` (SSE, filtered to this server) — drives live list updates.

Act (D2):
- `POST containers/:cid/{start,stop,restart,kill,pause,unpause}` · `DELETE containers/:cid?force&volumes`
- `POST images/pull {image, tag}` (streams progress over SSE) · `DELETE images/:iid?force`
- `POST prune {containers, images, volumes, networks, dangling}` — returns reclaimed space.
- `POST containers/:cid/env/reveal` (admin + passkey step-up) — unredacted env, audited.

Exec (D3):
- `POST containers/:cid/exec {cmd = ['/bin/sh'], user?, tty = true}` → creates a broker-style session id; the web attaches over the existing terminal WebSocket path (`/api/ssh-sessions/:id/ws` pattern, new `kind: 'container'`). Resize maps to `/exec/:id/resize`. Tries `/bin/bash` first when the shell is not given, falls back to `/bin/sh`.

Compose (D4):
- `GET compose` (projects with services, state, working dir, config files) · `POST compose/:project/{up,down,pull,restart}` (streams CLI output over SSE) · `GET compose/:project/logs` (SSE, merges service logs with prefixes).

Server settings:
- `PATCH /api/servers/:id` accepts `dockerMode`, `dockerSocketPath` (admin). Changing the socket path clears the cached transport.

All streaming endpoints use the same SSE conventions as AI chat (heartbeat comments, abort on client disconnect, per-user concurrency cap of e.g. 8 open streams).

### 4.4 AI tools (D5)

Added to `AGENT_TOOLS`, all read-only, all respecting per-server access:
- `docker_list_containers {server_id, all?}`
- `docker_container_logs {server_id, container, tail ≤ 500, since?}` — output truncated like `run_command`.
- `docker_inspect {server_id, container}` — redacted form only.

Mutations stay on `run_command` → approval.

### 4.5 Monitoring and alerts (D5)

The health probe (already per-server over SSH) optionally samples `GET /containers/json?all=1` when `docker_mode = 'auto'` and the daemon was detected. New alert types through the existing alert/notification pipeline:
- `container_unhealthy` — healthcheck status `unhealthy`.
- `container_restarting` — restart count grew by ≥ 3 within 10 minutes.
- `container_exited` — exited non-zero, only for containers with a restart policy other than `no` (i.e. meant to be running).

Alerts dedupe per (server, container name, type) like existing alerts. Opt-in per org (default off) to avoid noise on first rollout.

### 4.6 Fleet view (D5)

`GET /api/docker/containers?serverIds=…` fans out to accessible servers with concurrency 5 and per-server timeout 10 s, returning partial results with per-server errors. Used by a cross-server "Containers" page (search by name/image, filter by state).

## 5. Web

- **Server page → "Docker" tab** (hidden when `docker_mode = 'off'` or never detected; shows a "Detect Docker" button for admins):
  - Header: engine version, API version, transport, socket path, disk usage, root-equivalence notice.
  - Tabs: **Containers** (table: name, image, state/health badge, uptime, ports, CPU/mem sparkline when expanded; row actions per role), **Images** (tag, size, created, in-use badge; pull dialog with progress), **Volumes**, **Networks**, **Compose** (projects → services).
  - Container drawer: overview, logs (follow, search, timestamps, download), stats chart, redacted env with admin "Reveal", inspect JSON viewer, "Open shell".
  - Destructive actions use confirm dialogs that name the container/image; prune shows a dry-run summary (`/system/df`) first.
- **Terminal:** container sessions reuse `XTerminal` with a header "container `name` on `server`".
- **Containers page** (fleet view) in the sidebar under Servers.
- **Recordings page:** filter by container.
- Live updates: the containers list subscribes to `GET events` while visible.

## 6. Permissions

| Capability | viewer | operator | admin/owner |
| --- | --- | --- | --- |
| List containers/images/volumes/networks, status, compose status | ✓ | ✓ | ✓ |
| Logs, stats, top, redacted inspect | — | ✓ | ✓ |
| Start/stop/restart/pause/kill | — | ✓ | ✓ |
| Exec shell | — | ✓ if `operatorsCanExec` | ✓ |
| Remove containers, remove images | — | ✓ if `operatorsCanRemove` | ✓ |
| Pull images, compose up/down/pull/restart | — | ✓ | ✓ |
| Prune | — | — | ✓ if `allowPrune` |
| Reveal env | — | — | ✓ + passkey step-up |
| Docker settings on a server, probe | — | — | ✓ |

Viewers get no logs by default because logs routinely contain tokens and PII. Read-only API tokens are capped at viewer as today. Time-limited access grants and suspensions apply automatically (per-server access + `revokeLiveAccess`).

## 7. Security

1. **Host keys and routing:** every SSH connection via `sshConnectConfig` + `connectSsh`; no second SSH client path.
2. **No daemon exposure:** the app never asks users to expose the Docker TCP port; the socket is only reached through SSH.
3. **Container/image ids** are validated (`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$` for names, hex for ids) before use in API paths; path segments are `encodeURIComponent`-ed.
4. **Compose arguments:** project names, file paths and working dirs come from daemon labels, but are still treated as untrusted: passed as separate argv elements through a quoting helper that single-quotes and escapes, never concatenated into a shell string with user input. Only the fixed verbs above are allowed.
5. **Pull:** image references validated against the Docker reference grammar; no registry credentials are stored in this phase (public images or credentials already configured on the server).
6. **Audit:** every mutating call, exec start/end, env reveal, prune (with reclaimed bytes), compose action (with exit code). Reads are not audited, except env reveal.
7. **Resource limits:** SSE streams capped per user; log `tail` capped at 10 000 lines; downloads of logs streamed, not buffered; exec sessions follow the broker's idle and output caps.
8. **Recording:** exec output recorded per org settings; keystroke capture follows the same org switch as terminals.

## 8. Testing

- **Unit:** demux framing; redaction; error mapping; compose argv quoting (hostile label values); id/reference validation; API-version negotiation.
- **Transport tests with a fake daemon:** an in-process HTTP server on a Unix socket, reached through a mocked ssh2 channel for streamlocal and a mocked exec for dial-stdio; covers JSON calls, chunked streaming, hijacked exec (`Upgrade: tcp`), disconnect cleanup.
- **Route tests** (`app.inject`): role matrix from §6, per-server access 404s, org settings toggles, step-up for reveal, audit rows, SSE cancellation.
- **Integration (skipped by default, like the SFTP one):** a throwaway `docker:dind` container plus an `openssh-server` container sharing the dind socket, on unusual ports; exercises probe, list, logs follow, start/stop, exec with TTY resize, compose up/down on a tiny project, prune. Never touches the host's own Docker socket.
- **Playwright:** Docker tab renders against a stubbed API; container drawer; confirm dialogs.

## 9. Rollout

1. D1 behind `docker_mode = 'auto'` with detection on demand only (no background probing) — zero impact on servers without Docker.
2. D2 + D3 once D1 has run against the real servers.
3. D4, then D5 alerts opt-in.

Each phase is a separate branch, reviewed and merged like previous features.

## 10. Effort estimate

| Phase | Rough size |
| --- | --- |
| D1 transport, client, read routes, Docker tab | 3–4 days |
| D2 actions, confirmations, audit | 1–2 days |
| D3 exec + recording | 2 days |
| D4 compose | 2 days |
| D5 AI tools, alerts, fleet view | 2–3 days |

## 11. Kubernetes (not in this spec)

Kept for a follow-up spec after D1–D3 ship: per-cluster kubeconfig stored encrypted, API server reached directly or through the existing jump/agent tunnels, read-mostly slice (namespaces, workloads, pod logs/exec, events, rollout restart, scale), Kubernetes RBAC respected via impersonation or per-user credentials. The Docker transport and streaming pieces (SSE conventions, exec terminal, recording hooks) are designed to be reused there.

## 12. Decisions (resolved open questions)

1. **Viewer access to logs:** denied by default; not an org setting in this round.
2. **Operator defaults:** exec allowed (`operatorsCanExec: true`), remove denied (`operatorsCanRemove: false`); both are org settings.
3. **Container alerts:** opt-in per org, default off.
4. **Podman:** supported only through its Docker-compatible socket (socket path override).
5. **Registry credentials:** out of scope; pulls use public images or credentials already configured on the server.
