# syntax=docker/dockerfile:1
# Single image for the whole system: dashboard control plane + built frontend.
# The control plane spawns lighthouses and mesh nodes as child processes inside
# this container (same code path as the native `npm start`).
#
# Pinned base: Node 24.21.0 LTS on Alpine 3.24, multi-arch (linux/arm64 for
# Apple Silicon, linux/amd64 elsewhere). No native modules anywhere in the
# dependency tree, so the same lockfiles resolve identically on every platform.
ARG NODE_IMAGE=node:24.21.0-alpine3.24

# ---------- stage 1: build the dashboard (Vite + React) ----------
FROM ${NODE_IMAGE} AS frontend
WORKDIR /app/frontend-network-mesh
COPY frontend-network-mesh/package.json frontend-network-mesh/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend-network-mesh/ ./
RUN npm run build          # tsc --noEmit && vite build → dist/

# ---------- stage 2: compile the mesh + control plane to plain JavaScript ----------
# TypeScript is a build-time tool only. The runtime below runs `node dist/...`
# with no loader: each of the nine mesh processes then starts in ~70 ms and
# ~40 MB instead of the ~330 ms and ~80 MB (plus an esbuild service process
# each) that `node --import tsx` costs.
FROM ${NODE_IMAGE} AS backend
WORKDIR /app/backend-network-mesh
COPY backend-network-mesh/package.json backend-network-mesh/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend-network-mesh/ ./
RUN npm run build          # typechecks and emits dist/ (src/ + backend/src/)

# ---------- stage 3: runtime ----------
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="network-mesh" \
      org.opencontainers.image.description="Self-healing SWIM/lighthouse overlay mesh with defense threat matchmaking and live dashboard"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7070 \
    FRONTEND_DIST=/app/frontend-network-mesh/dist
WORKDIR /app/backend-network-mesh
# Node built-ins only, so no node_modules ship: just the compiled code and the
# package.json that marks it as ES modules.
COPY --from=backend  /app/backend-network-mesh/package.json ./package.json
COPY --from=backend  /app/backend-network-mesh/dist         ./dist
COPY --from=frontend /app/frontend-network-mesh/dist /app/frontend-network-mesh/dist
# Run as the unprivileged user the base image ships with. /data holds the
# persisted location table (a named volume in compose); pre-create it owned by
# node so the volume inherits writable ownership.
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]
USER node
EXPOSE 7070/tcp 4001-4008/udp 5001-5003/udp
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7070/api/state || exit 1
# Same shape procman.ts uses for its children (`node dist/src/<entry>.js`).
CMD ["node", "dist/backend/src/server.js"]
