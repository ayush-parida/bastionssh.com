---
title: Compose projects
section: docker
order: 40
summary: See Docker Compose projects on a server, run up, restart, pull and down on a project or one service, and read merged project logs.
keywords: [docker compose, compose, up, down, restart, pull, stop, services, no-deps, project logs]
---

The **Compose** tab on a server's Docker page (**Servers → a server → Docker → Compose**) lists the Docker Compose projects running on that server, with each service's containers and their state. Operators can run the common Compose commands on a project and watch the output live.

## How projects are found

BastionSSH does not read your `docker-compose.yml` files directly. It finds projects from the labels Docker Compose puts on every container it creates: the project name, the service, the working directory and the compose files used.

This has two consequences:

- A project only shows up while it has containers. After `down`, it has none left, so it disappears from the list until someone starts it again on the server.
- Projects started with a very old Compose version, or whose containers disagree about their working directory or compose files, are listed but cannot be managed. The project shows **Actions unavailable** with the reason, and its buttons are greyed out.

## Running an action

Each project row has four buttons:

| Button | Runs | What it does |
| --- | --- | --- |
| **Up** | `docker compose up --detach` | Creates and starts every service, recreating containers whose configuration or image changed |
| **Restart** | `docker compose restart` | Restarts every service's containers. Configuration changes are **not** applied; use **Up** for that |
| **Pull** | `docker compose pull` | Pulls the images of every service. Running containers keep their current image until the next **Up** |
| **Down** | `docker compose down` | Stops and removes the project's containers and networks. Volumes are kept |

To run one:

1. Click the button on the project's row.
2. Read the confirmation, which names the project and explains what will happen.
3. Confirm. The command's output streams into the dialog as it runs, and the exit code is shown at the end.

The command runs in the project's recorded working directory, with its recorded compose files, exactly as if you had run it there yourself.

> **Note:** If you close the dialog, the action keeps running on the server. Check the project list or the audit log for the result.

Only one action can run on a project at a time (a service action counts as one); starting a second one while the first is running is refused. An action that runs longer than 15 minutes is stopped.

## Actions on one service

Each service row has its own buttons, which act on that service only:

| Button | Runs | What it does |
| --- | --- | --- |
| **Up** | `docker compose up --detach --no-deps <service>` | Recreates the service's containers if its image or configuration changed, and starts them. The services it depends on are left alone |
| **Restart** | `docker compose restart <service>` | Restarts its containers as they are; a new image is **not** picked up |
| **Pull** | `docker compose pull <service>` | Pulls its image; running containers keep the old one until the next **Up** |
| **Stop** | `docker compose stop <service>` | Stops its containers; they are kept |

Use the service's **Up** after its image changed under the same tag — for example after [uploading an image you built on your machine](/docs/docker/upload-image), which can also run it for you. Service names are checked against the project's containers before anything runs.

### What the server needs

Actions run the `docker compose` command on the server, so the **Docker CLI with the Compose plugin** must be installed there (the `docker compose` form, not the old standalone `docker-compose`). Listing projects only needs the Docker API.

### Safety

Label values on containers are written by whoever started the project, so BastionSSH treats them as untrusted. They are never interpreted by the shell: every value is passed as a separate, quoted argument, and only the fixed commands above can run.

## Project logs

Click **Logs** on a project to see the output of all its containers merged into one view. Each line is prefixed with the container it came from, for example `web-1 |`.

- Pick a single service, or **All services**.
- Follow new lines, or pause.
- Choose how many lines of history to load per container: 50, 200 (the default), 1,000 or 5,000.
- Tick **Timestamps** to prefix each line with its time.

Logs need the operate level on the server, as for single containers.

## Who can do what

| Level on the server | Can |
| --- | --- |
| view | See projects, services and container states |
| operate | Also run **Up**, **Restart**, **Pull** and **Down** on a project, **Up**, **Restart**, **Pull** and **Stop** on a service, and read project logs |

Every action is recorded in the audit log against the server, with the project name, the service when there is one, and the command's exit code.

## Related

- [Docker on servers](/docs/docker/docker-on-servers) for setup and permissions
- [Containers & actions](/docs/docker/containers-and-actions) for single containers
- [Deploy an image built on your machine](/docs/docker/upload-image) for uploading an image and updating its service
- [Deployments](/docs/deployments/overview) for building and deploying web apps to a server
