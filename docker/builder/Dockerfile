# syntax=docker/dockerfile:1.7
#
# The build-plane image. This is the container that runs untrusted code, so the
# priorities are: small surface, no secrets baked in, and never root.
#
# Three stages so the final image carries only a single bundled JS file — no
# node_modules, no TypeScript, no build tooling for an attacker to find.

# ---------- deps: install once, cached on lockfile changes ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/builder/package.json apps/builder/
RUN npm ci --no-audit --no-fund

# ---------- build: typecheck, then bundle ----------
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
# tsc checks types; esbuild emits. Different jobs, both run.
RUN npx tsc --noEmit -p tsconfig.json
RUN node apps/builder/build.mjs

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime

# ca-certificates: npm registry over TLS. git: some packages shell out to it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    BUILDER_MODE=local \
    WORK_DIR=/workspace \
    OUTPUT_DIR=/out \
    CONTAINER_MEMORY_MB=2048

WORKDIR /app
COPY --from=build /app/apps/builder/dist/builder.mjs /app/builder.mjs

RUN mkdir -p /workspace /out \
 && chown -R node:node /workspace /out /app

# Never root. The `node` user ships with the base image.
USER node

# Image smoke test at BUILD time. Docker's HEALTHCHECK is for long-running
# services that get re-probed; this container is a one-shot batch job that exits
# when the build ends, so a runtime healthcheck would be meaningless. Running
# doctor here turns "the image is missing npm" into a failed `docker build`
# instead of a mystery on the first real deployment.
RUN node /app/builder.mjs doctor

ENTRYPOINT ["node", "/app/builder.mjs"]
CMD ["help"]
