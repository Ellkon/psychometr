# Build context: repository root.
FROM node:22-alpine AS base
RUN npm install -g pnpm@12.14.0 && npm cache clean --force
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @kompas/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @kompas/api build

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter @kompas/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# npm/corepack are not needed at runtime and carry their own CVEs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules node_modules
COPY --from=deps --chown=root:root /app/apps/api/node_modules apps/api/node_modules
COPY --from=build --chown=root:root /app/apps/api/dist apps/api/dist
COPY --chown=root:root apps/api/package.json apps/api/
USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/server.js"]
