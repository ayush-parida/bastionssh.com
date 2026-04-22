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

RUN pnpm --filter @smt/web build

# ─── Stage 2: Build server ────────────────────────────────────────────────────
FROM node:22-alpine AS server-builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/cron-parser/package.json packages/cron-parser/
COPY apps/server/package.json apps/server/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/server/ apps/server/

RUN pnpm --filter @smt/server build

# ─── Stage 3: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Production deps only
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/cron-parser/package.json packages/cron-parser/
COPY apps/server/package.json apps/server/

RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=server-builder /app/apps/server/dist ./apps/server/dist
COPY --from=web-builder    /app/apps/web/dist    ./apps/web/dist

# Migrations
COPY apps/server/src/db/migrations ./apps/server/src/db/migrations

ENV NODE_ENV=production \
    SMT_PORT=8080 \
    SMT_STATIC_DIR=/app/apps/web/dist

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD wget -qO- http://localhost:8080/api/healthz || exit 1

CMD ["node", "apps/server/dist/index.js"]
