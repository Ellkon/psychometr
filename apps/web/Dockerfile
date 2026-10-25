# Web image: build the PWA, serve it with Caddy (self-hosted assets only).
# Build context is the repo root so the shared package and Caddyfile are visible.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/web apps/web
# Emergency instruction text is bundled from content/ (offline, FR-5.4).
COPY content content
RUN pnpm --filter @psychometr/shared build && pnpm --filter @psychometr/web build

# The official 2.11.7 binary embeds vulnerable Go 1.26.8 and x/net 0.59.0.
# Rebuild the same release with patched dependencies instead of ignoring CVEs.
FROM golang:1.27.3-alpine AS caddy-build
WORKDIR /src
RUN go mod init psychometr.local/caddy \
    && go get github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.7 golang.org/x/net@v0.60.0 \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /caddy \
        github.com/caddyserver/caddy/v2/cmd/caddy

FROM caddy:2.11.7-alpine AS runtime
COPY --from=caddy-build /caddy /usr/bin/caddy
# Patched Alpine packages from the base (Trivy HIGH/CRITICAL gate), e.g. brotli-libs.
RUN apk upgrade --no-cache \
    && setcap cap_net_bind_service=+ep /usr/bin/caddy \
    && addgroup -S caddy && adduser -S -D -H -G caddy caddy \
    && chown -R caddy:caddy /data /config
COPY --from=build /app/apps/web/dist /srv
COPY infra/Caddyfile /etc/caddy/Caddyfile
USER caddy
EXPOSE 80 443
