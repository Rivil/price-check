# syntax=docker/dockerfile:1

# ---- base: node + pinned pnpm via corepack (packageManager in package.json) ----
FROM node:24.22.2-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ---- deps: full install (dev + prod) from the lockfile ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# ---- dev: used by compose.yaml; source is bind-mounted over /app ----
# Chromium + system deps for vitest browser-mode tests and Playwright e2e.
# procps provides `ps`, which Stryker needs to stop its test-runner processes.
FROM deps AS dev
RUN pnpm exec playwright install --with-deps chromium \
 && apt-get update \
 && apt-get install -y --no-install-recommends procps \
 && rm -rf /var/lib/apt/lists/*
EXPOSE 5173
CMD ["pnpm", "dev", "--host", "0.0.0.0", "--port", "5173"]

# ---- build: adapter-node server, then drop dev deps ----
# SvelteKit's build analysis imports server modules (db, auth), which read env at
# import. .env is never in the build context, so the build step alone gets
# NON-SECRET placeholders. Private vars are dynamic (not inlined): the runtime
# container's real env is what the server uses. The grep fails the build if a
# placeholder ever leaks into the output.
FROM deps AS build
COPY . .
RUN DATABASE_URL=file::memory: \
    ORIGIN=http://build.invalid \
    BETTER_AUTH_SECRET=build-only-placeholder-not-a-secret-0000 \
    pnpm build \
 && ! grep -rqE 'build-only-placeholder|build\.invalid' build \
 && pnpm prune --prod --ignore-scripts

# ---- runtime: production image (docker build --target runtime) ----
FROM node:24.22.2-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS runtime
WORKDIR /app
# adapter-node 6 takes the request origin from headers, defaulting to https: run
# behind a TLS reverse proxy that keeps Host and sets X-Forwarded-Proto. Plain
# http straight to :3000 fails SvelteKit's CSRF check on every form POST.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PROTOCOL_HEADER=x-forwarded-proto \
    DATABASE_URL=file:/data/app.db

COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
# Migrations: the server applies them at startup (hooks.server.ts init).
COPY --from=build /app/drizzle ./drizzle
# Server-side sources for the first-admin CLI, run with Node's type stripping:
#   docker exec -it <container> node src/lib/server/cli/admin-create.ts
COPY --from=build /app/src/lib/server ./src/lib/server

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

CMD ["node", "build"]
