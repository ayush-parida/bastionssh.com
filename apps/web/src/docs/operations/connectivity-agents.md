---
title: Connectivity agents
section: operations
order: 30
summary: Reach a server behind a firewall or NAT with a small outbound agent, without opening any inbound port.
keywords: [agent, nat, firewall, private network, tunnel, outbound, install, token, allowed ports, systemd]
---

Some machines cannot accept an SSH connection from BastionSSH: they sit behind NAT, a home router or a strict firewall. A **connectivity agent** solves this. It is a small service you install on that machine. It dials **out** to BastionSSH over a WebSocket and keeps the connection open, and BastionSSH sends that machine's SSH traffic back through it. Nothing on the machine needs to accept inbound connections.

## How it works and what it can reach

- The agent connects to `SMT_BASE_URL` (your BastionSSH address) and authenticates with its own token.
- It only ever connects to its **own loopback** (`127.0.0.1`) on the ports in its allowlist (port 22 by default). It cannot be used to reach other machines on its network.
- It is treated as untrusted transport. SSH host keys are still verified end to end, and the agent never sees your SSH keys or passwords.

So install an agent on **each machine** you want to reach this way. To reach a whole private network through one machine instead, use that machine as a jump host (see [Adding servers](/docs/servers/adding-servers)); a jump host may itself sit behind an agent.

## Requirements on the machine

- Linux with systemd
- Node.js 18 or newer on the `PATH`
- `curl` or `wget`, and outbound HTTPS to your BastionSSH address
- Root (sudo) to install

> **Note:** The agent refuses a plain `http://` BastionSSH address unless `BASTION_ALLOW_INSECURE=1` is set. Serve BastionSSH over HTTPS (see [Installing & upgrading](/docs/operations/installing-and-upgrading)).

## Create and install an agent

1. Open **Agents** in the sidebar and click **New agent**.
2. Enter a **Name** (for example `office-nas`) and the **Allowed local ports** (default `22`; up to 16, comma separated). Add other ports only if you need them, for example `6443` for a Kubernetes API server on that machine.
3. Click **Create agent**. An install command is shown **once**. Copy it with **Copy**.
4. On the machine, paste all three lines into a shell:

   ```bash
   f="$(mktemp)" && curl -fsSL 'https://bastion.example.com/api/agents/install.sh' -o "$f" && sudo sh "$f" <<'BASTION_AGENT_TOKEN'; rm -f "$f"
   bsa_…your token…
   BASTION_AGENT_TOKEN
   ```

5. The installer downloads the agent, checks its SHA-256 against the copy your BastionSSH serves, installs it in `/opt/bastion-agent`, writes the token to `/etc/bastion-agent/agent.env` (root-only, mode 600), and starts the `bastion-agent` systemd service.
6. Back in **Agents**, the agent shows as **online** within a few seconds.

The token is passed on standard input from a here-doc, so it never appears in a process list (`ps`). The installer refuses to be piped straight into `sh` and ignores a token in the environment.

> **Warning:** An interactive shell still saves the pasted here-doc in its history. To avoid that, download the script and run `sudo sh install.sh` on its own; it asks for the token at a prompt that does not echo.

Only a hash of the token is stored in BastionSSH. If you lose it, revoke the agent and create a new one.

## Point a server at the agent

1. Open **Servers**, edit the server (or add it).
2. Under **Connect via**, pick **Agent: office-nas (online)**.
3. Set **Port** to the port sshd listens on *on that machine* (usually 22). It must be in the agent's allowlist.
4. The **Host** field is only a label for a server behind an agent; the agent always connects to `127.0.0.1`.
5. Save. Pin the server's host key up front if you can (see [Host keys](/docs/servers/host-keys)).

A server uses either a jump host or an agent, not both. Terminals, file browsing, health checks, Docker, diagnostics and the other server features all work through the agent.

## Checking on an agent

On the machine:

```bash
systemctl status bastion-agent
journalctl -u bastion-agent -f
```

In BastionSSH, **Agents** shows each agent's status (**online**, **offline** or **revoked**) and when it was last seen. **Diagnostics** on a server behind an agent runs its checks through the tunnel (see [Diagnostics](/docs/servers/diagnostics)).

The service runs unprivileged with a locked-down systemd profile (no write access to the system, no extra capabilities) and restarts by itself if it stops.

## Changing allowed ports

The allowlist is enforced by the agent, from `BASTION_ALLOWED_PORTS` in `/etc/bastion-agent/agent.env`. To change it, edit that line on the machine and restart the service:

```bash
sudo sed -i 's/^BASTION_ALLOWED_PORTS=.*/BASTION_ALLOWED_PORTS=22,6443/' /etc/bastion-agent/agent.env
sudo systemctl restart bastion-agent
```

## Revoking an agent

Click **Revoke** on the agent. Its connection is dropped at once and its token stops working. Servers that used it **fail closed**: they do not fall back to a direct connection. Revoking is recorded in the audit log.

To remove the software from the machine:

```bash
sudo systemctl disable --now bastion-agent
sudo rm -rf /etc/systemd/system/bastion-agent.service /opt/bastion-agent /etc/bastion-agent
sudo systemctl daemon-reload
```

## Limits

- Agent connections live in the main BastionSSH process. If you run cron jobs in a separate worker process, those jobs cannot use agents.
- Creating, revoking and assigning agents needs the **Agents** module at **manage** (admins and owners by default). The **Agents** page only lists agents for members with **manage**; at **view** it shows "Only admins can manage connectivity agents."
- Creating an agent asks for a passkey confirmation when you have a passkey.
