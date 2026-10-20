# Build context: repository root.
FROM node:22-alpine AS build
RUN npm install -g pnpm@12.14.0 && npm cache clean --force
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @kompas/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @kompas/web build

FROM caddy:2.11-alpine AS runtime
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
# Drop the binary's file capability: the container runs with cap_drop ALL and
# listens on unprivileged ports, so exec would fail with it present.
RUN apk add --no-cache libcap \
  && setcap -r /usr/bin/caddy \
  && apk del libcap \
  && addgroup -S caddy && adduser -S -G caddy caddy \
  && chown -R caddy:caddy /data /config
USER caddy
EXPOSE 8080 8443
