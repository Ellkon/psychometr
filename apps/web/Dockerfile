# Web image: build the PWA, serve it with Caddy (self-hosted assets only).
# Build context is the repo root so the shared package and Caddyfile are visible.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @psychometr/shared build && pnpm --filter @psychometr/web build

FROM caddy:2-alpine AS runtime
COPY --from=build /app/apps/web/dist /srv
COPY infra/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80 443
