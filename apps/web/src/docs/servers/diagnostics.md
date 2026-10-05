---
title: Diagnostics
section: servers
order: 60
summary: Find out why a connection fails — step-by-step checks of DNS, the port, the SSH banner, the host key and the login, with fixes and the firewall rule to add for BastionSSH's outbound IP.
keywords: [diagnose, diagnostics, troubleshooting, connection failed, firewall, egress ip, outbound ip, timeout, security group]
---

"Connection timed out" says little. **Diagnose** walks through a connection one step at a time, stops at the first step that fails, and tells you what to check next — including the exact firewall rule to add for BastionSSH's own public IP.

## Where to find it

- **Servers** → **Diagnose** on a server card.
- The error toast when a terminal or command cannot connect: **Run diagnostics**.
- The terminal toolbar after a session drops: **Diagnose**.
- The same button exists on FTP/SFTP connections, object storage connections and Kubernetes clusters.

A dialog titled **Diagnose *server name*** opens and runs the checks straight away. A filtered port can take a few seconds to time out.

## The steps

For a server, the checks run in this order. Each one shows **ok**, **warn**, **fail** or **skipped**, how long it took, what was found, and — when something is wrong — a suggested fix you can copy.

| Step | What it checks | Typical failure |
| --- | --- | --- |
| **DNS resolution** | The host name resolves to an address. A plain IP passes straight away. | Typo in the host, or a record that does not exist yet. |
| **TCP connection** | The SSH port accepts a connection. Tells *refused* (nothing listening, or a firewall that rejects) from *filtered* (packets silently dropped) and *unreachable*. | Firewall or cloud security group not allowing BastionSSH; sshd on another port. |
| **SSH banner** | Something answers on the port and it is really SSH. | Another service on the port, or a proxy in the way. |
| **Host key** | The key the server presents matches the pinned one. | The server was rebuilt — or someone is intercepting. See [Host keys](/docs/servers/host-keys). |
| **Authentication** | Logs in with the stored key or password. Only when you ask for it. | Public key missing from `authorized_keys`, wrong user, wrong password, retired key. |
| **Docker** | Whether Docker is reachable for this SSH user. Only with a login, and only when Docker detection is on for the server. | Docker not installed, daemon down, user not in the `docker` group. |

Once a step fails, the steps after it are marked **skipped**. The summary at the top says either "*host:port* is reachable" or "Stopped at *step*".

### Testing the login

By default diagnostics does not log in. Click **Test login too** to run the checks again and, at the end, sign in with the server's stored credentials. Click **Run again** to repeat the run without a login.

### Jump hosts and agents

- Behind a **jump host**, the network steps (DNS, TCP, banner) check the **first hop** — the only machine BastionSSH connects to directly. The host key and login checks then go through the whole chain.
- Behind a **connectivity agent**, the checks run over the agent's tunnel.

People who cannot access a jump host are told only which hop failed, not its address; an admin running Diagnose sees the full error.

## BastionSSH's outbound IP

When the TCP step finds a filtered port, the fix includes BastionSSH's public (egress) IP — the address your servers see connections come from — written as a rule you can paste, for example:

```text
Allow inbound TCP 22 from 203.0.113.7/32 (AWS security group: Type SSH, Source 203.0.113.7/32).
On the host itself: sudo ufw allow from 203.0.113.7 to any port 22 proto tcp.
```

If the target is a **private** address, the advice changes: the connection then comes from BastionSSH's own host or container network, not its public IP, so you allow the app host's private address or subnet instead.

The bottom of every result shows "Connections leave from *IP*" with a copy button. The same address is under **Settings → Outbound IP**, with **Copy as CIDR** and a button to look it up again.

### How the IP is found

| Setting | Behaviour |
| --- | --- |
| *(default)* | Looked up from public IP echo services, `https://api.ipify.org` then `https://ifconfig.me/ip`, and cached for 10 minutes. |
| `SMT_EGRESS_IP=203.0.113.7` | Use this address and never look it up. Use it when traffic leaves through a NAT gateway or proxy the echo services cannot see. |
| `SMT_EGRESS_IP=off` | Never look it up. Firewall advice then asks you to find the address yourself. |
| `SMT_EGRESS_IP_SERVICES=…` | A comma-separated list of other echo services to ask. |

> **Note:** The egress lookup is the only outbound call BastionSSH makes on its own. Set `SMT_EGRESS_IP` to a fixed address or `off` if your network policy forbids it.

## Who can run it, and limits

- You need the **DNS Lookup & Diagnostics** module (included in the built-in Operator, Admin and Owner roles) and the *operate* level on the server you diagnose.
- The presented host key in a mismatch is shown only to people who manage that server's host keys.
- Each run is written to the audit log (`server.diagnose`).
- Runs are limited to **10 per minute per user**.

## A quick checklist when the TCP step fails

1. Is the server running, and is its IP still the same? Cloud instances that were stopped and started may have a new public IP.
2. Is sshd listening on the port you entered? On the server: `sudo ss -tlnp | grep ssh`.
3. Does the server's firewall (`ufw`, `firewalld`, `iptables`) allow the egress IP on that port?
4. Does the cloud security group or network ACL allow it?
5. If the server has no public address at all, reach it through a [jump host](/docs/servers/adding-servers) or a [connectivity agent](/docs/operations/connectivity-agents).
