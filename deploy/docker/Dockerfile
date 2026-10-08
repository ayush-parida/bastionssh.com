# syntax=docker/dockerfile:1.7
# ─── Stage 1: Build web ───────────────────────────────────────────────────────
FROM node:22-alpine AS web-builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/cron-parser/package.json packages/cron-parser/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/web/ apps/web/

RUN pnpm --filter @smt/shared build && \
    pnpm --filter @smt/web build

# ─── Stage 2: Build server ────────────────────────────────────────────────────
FROM node:22-alpine AS server-builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/cron-parser/package.json packages/cron-parser/
COPY packages/agent/package.json packages/agent/
COPY packages/bastionctl/package.json packages/bastionctl/
COPY apps/server/package.json apps/server/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/server/ apps/server/

# The agent is also bundled into one file the server hands to install scripts,
# and bastionctl into the file it installs on servers for deployments
RUN pnpm --filter @smt/shared build && \
    pnpm --filter @smt/cron-parser build && \
    pnpm --filter @smt/agent build && \
    pnpm --filter @smt/bastionctl build && \
    pnpm --filter @smt/server build

# ─── Stage 3: buildctl (builds on the BastionSSH side) ────────────────────────
# The client BastionSSH drives its buildkit service with (docker-compose.yml),
# pinned to the same BuildKit release as that service, downloaded from the
# release and checked against its published SHA-256 before it is used.
FROM alpine:3.22 AS buildctl
ARG TARGETARCH
ARG BUILDKIT_VERSION=v0.33.1
ARG BUILDCTL_SHA256_AMD64=4e044bcd62a0c0bbe6a8c94d73989de2bfe4c04dbc0f9d6021cf96b72cd1d965
ARG BUILDCTL_SHA256_ARM64=4e1ba91f139761f249a1fa6c71e632dfdbdafeda416176ecadefbb95225e56c4
RUN set -eu; \
    case "${TARGETARCH:-$(uname -m)}" in \
      amd64|x86_64) arch=amd64; sum="$BUILDCTL_SHA256_AMD64" ;; \
      arm64|aarch64) arch=arm64; sum="$BUILDCTL_SHA256_ARM64" ;; \
      *) echo "No pinned buildctl for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    wget -qO /tmp/buildkit.tar.gz "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-${arch}.tar.gz"; \
    echo "${sum}  /tmp/buildkit.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/buildkit.tar.gz -C /usr/local bin/buildctl; \
    rm /tmp/buildkit.tar.gz; \
    /usr/local/bin/buildctl --version

# ─── Stage 4: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Production deps only
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/cron-parser/package.json packages/cron-parser/
COPY packages/agent/package.json packages/agent/
COPY packages/bastionctl/package.json packages/bastionctl/
COPY apps/server/package.json apps/server/

RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=server-builder /app/packages/shared/dist     ./packages/shared/dist
COPY --from=server-builder /app/packages/cron-parser/dist ./packages/cron-parser/dist
COPY --from=server-builder /app/packages/agent/dist      ./packages/agent/dist
COPY --from=server-builder /app/packages/bastionctl/dist ./packages/bastionctl/dist
COPY --from=server-builder /app/apps/server/dist ./apps/server/dist
COPY --from=web-builder    /app/apps/web/dist    ./apps/web/dist

# Migrations
COPY apps/server/src/db/migrations ./apps/server/dist/db/migrations

# buildctl, checked above: talks to the buildkit service for build.where: bastion
COPY --from=buildctl /usr/local/bin/buildctl /usr/local/bin/buildctl

ENV NODE_ENV=production \
    SMT_PORT=8080 \
    SMT_STATIC_DIR=/app/apps/web/dist \
    SMT_BUILDCTL_PATH=/usr/local/bin/buildctl

EXPOSE 8080
# 127.0.0.1, not localhost: the server binds IPv4 only, and localhost resolves to ::1 first
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "apps/server/dist/index.js"]
