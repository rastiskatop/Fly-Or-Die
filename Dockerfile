# syntax=docker/dockerfile:1
# FlyOrDie — production image (Lab 8). Two stages:
#   build   : the whole workspace + dev dependencies → builds the client (Vite) into client/dist
#   runtime : node + production dependencies of server/shared + client/dist. No compiler, no Vite,
#             no tests, no dev deps — the server runs its .ts files with Node's native type stripping.

# Build on Debian (glibc): Vite 8's native parts (rolldown, lightningcss) failed to build the client
# on Alpine/musl in CI, while the same build passes on glibc. The RUNTIME stays Alpine — it has no
# native modules (ws, zod, pino, prom-client), so the small base is safe there.
ARG BUILD_IMAGE=node:24-slim
ARG RUNTIME_IMAGE=node:24-alpine

# ---------- stage 1: build ----------
FROM ${BUILD_IMAGE} AS build
WORKDIR /app
# Lockfile + package manifests FIRST: this layer (npm ci) is cached until a dependency changes,
# so a one-line code change doesn't re-download node_modules.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --no-audit --no-fund
COPY shared shared
COPY client client
# The version stamp (HUD): Render passes RENDER_GIT_COMMIT, CI passes GIT_SHA.
ARG GIT_SHA=""
ARG RENDER_GIT_COMMIT=""
RUN GIT_SHA="${GIT_SHA:-$RENDER_GIT_COMMIT}" npm run build -w client

# ---------- stage 2: runtime ----------
FROM ${RUNTIME_IMAGE} AS runtime
# tini as PID 1: forwards SIGTERM to node and reaps zombies (Node's docker best practices).
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
# Production dependencies of the server (and the shared workspace it links to) only.
RUN npm ci --omit=dev --no-audit --no-fund --workspace=server --workspace=shared \
  && npm cache clean --force
COPY shared/src shared/src
COPY server/src server/src
COPY --from=build /app/client/dist client/dist

ARG GIT_SHA=""
ARG RENDER_GIT_COMMIT=""
ENV GIT_SHA=${GIT_SHA} \
    STATIC_DIR=../client/dist \
    ARENA_DIR=../client/dist/assets/arenas \
    LOG_DIR=/tmp/flyordie-logs \
    PORT=8787
# Not root: the `node` user that ships with the image.
RUN mkdir -p /tmp/flyordie-logs && chown node:node /tmp/flyordie-logs
USER node
EXPOSE 8787

# Readiness probe, exec form (no shell): 200 only while listening and not shutting down.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Exec form: SIGTERM goes (via tini) straight to node — not to a shell or to npm, which would
# swallow it and get the container SIGKILLed after the grace period, dropping every player.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/src/index.ts"]
