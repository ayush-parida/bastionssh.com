---
title: Deploy with your own Dockerfile
section: deployments
order: 40
summary: Deploy an app in any language — Python, Go, PHP, Ruby, Node.js — by uploading its source with a Dockerfile.
keywords: [dockerfile, docker, python, go, golang, php, ruby, rust, java, django, flask, fastapi, express, container, image]
---

With `build.type: dockerfile`, the server builds your project with **your** `Dockerfile` and runs the image. Anything that can listen on an HTTP port works.

## What the app must do

- **Have a `Dockerfile` at the top of `build.dir`** (the upload's root unless you set `build.dir`). The build context is that folder; `.git` is left out of it.
- **Listen on `0.0.0.0`**, on the port `run.port` names (3000 unless you set it). Listening on `127.0.0.1` only makes the app unreachable from the proxy.
- **Answer the health check**: a `GET` of `healthcheck.path` (default `/`) must succeed within `healthcheck.timeout` (default 30 s) after the container starts. A redirect to a login page counts as long as the page answers.
- **Read secrets from its environment.** The app's `.env` is given to the container as environment variables when it starts — not to the build.
- **Keep data in volumes.** A container is replaced on every deploy; anything written inside it is gone. Declare [volumes](releases-rollback.md#volumes-for-persistent-data) for uploads, SQLite files and the like.

TLS is the proxy's job: serve plain HTTP.

## Configuration

```yaml
name: api
domains: [api.example.com]
build:
  type: dockerfile
  dir: .             # where the Dockerfile is, inside the upload
run:
  port: 8000
  memory: 256m
healthcheck: { path: /healthz, timeout: 30s }
```

`build.node` and `build.output` are not allowed with `dockerfile`: the Dockerfile picks its own base image.

## Examples

### Python (FastAPI)

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
USER nobody
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### Go

```dockerfile
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/server ./cmd/server

FROM alpine:3.20
COPY --from=build /out/server /usr/local/bin/server
USER nobody
EXPOSE 8080
CMD ["server"]
```

with `run.port: 8080`, and the server listening on `:8080`.

### Node.js (Express, NestJS…)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

## Tips

- **Pin your base images** (`python:3.12-slim@sha256:…`) for builds that do not change between deploys. BastionSSH pins the images it generates Dockerfiles with, but your `FROM` lines are yours.
- **Multi-stage builds** keep the running image small, which matters because every kept release keeps its image ([disk use](releases-rollback.md#resource-limits-and-server-sizing)).
- **Keep the upload small.** When you deploy a folder or zip, the browser leaves out `node_modules`, `.next` and `.git`; leave out other large things the image does not need, or upload a `.tar.gz` you made yourself.
- **Run as a non-root user** (`USER node`, `USER nobody`) where you can.
- **Build args and build-time secrets** are not supported: the build sees only the upload. Put runtime configuration in the [environment](environment.md).
- **Not reachable during the health check?** The failure shows the container's last log lines — see [Troubleshooting](troubleshooting.md#health-check-failed).
