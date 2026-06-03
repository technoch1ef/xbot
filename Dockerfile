# syntax=docker/dockerfile:1

# =============================================================================
# xbot — production container image
#
# Multi-stage build for a long-running worker (poller + optional webhook
# receiver). The image is slim, runs as a non-root user, and persists the
# SQLite database on a mounted volume so the mentions cursor and reply-dedupe
# history survive restarts.
#
# Native build packages: `better-sqlite3` ships a C++ addon that is compiled
# from source during `npm ci`. The build stages therefore install:
#   - python3   (node-gyp build driver)
#   - make      (build system)
#   - g++       (C++ compiler)
# These toolchain packages live ONLY in the build stages and never reach the
# final runtime image.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 — builder: full dependency install + TypeScript compile.
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Toolchain required to compile better-sqlite3's native addon.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install against the lockfile (includes devDependencies needed for `tsc`).
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript (src/ -> dist/).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2 — prod-deps: production-only node_modules with native addons built.
#
# Built in its own stage (same base image as runtime) so the compiled
# better-sqlite3 binary is ABI-compatible when copied into the final image,
# while the toolchain is discarded with this stage.
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# -----------------------------------------------------------------------------
# Stage 3 — runtime: slim, non-root, persistent volume.
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# Sensible production defaults. All secrets/credentials are supplied at runtime
# via the environment (e.g. --env-file) and are NEVER baked into the image.
ENV NODE_ENV=production \
    DATABASE_PATH=/data/xbot.db \
    HOST=0.0.0.0 \
    PORT=3000

# `pgrep` for the container HEALTHCHECK (process-based liveness).
RUN apt-get update \
    && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*

# Production dependencies (with the compiled better-sqlite3 addon), the built
# JavaScript, the manifest, and the persona prompt the generator reads at boot.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY prompts ./prompts

# Persistent data directory for the SQLite DB, owned by the unprivileged
# `node` user that ships with the base image.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

# Drop privileges — never run the worker as root.
USER node

# Documents the health/webhook port (only bound when WEBHOOK_ENABLED=true).
EXPOSE 3000

# Liveness via a process check rather than an HTTP probe: the /health endpoint
# is only served when WEBHOOK_ENABLED=true, whereas the poller worker always
# runs. If the main process dies, the container is reported unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD pgrep -f "dist/index.js" > /dev/null || exit 1

# The app installs its own SIGINT/SIGTERM handlers for a graceful, drain-on-stop
# shutdown, so node runs directly as PID 1 and receives orchestrator signals.
ENTRYPOINT ["node", "dist/index.js"]
