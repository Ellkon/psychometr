# API image: multi-stage, non-root runtime. Build context is the repo root.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @psychometr/shared build && pnpm --filter @psychometr/api build

# pnpm prune is not recursive in a workspace. Install runtime dependencies in a
# clean stage instead, preserving the workspace symlinks without dev packages.
FROM node:22-alpine AS production-deps
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --prod --frozen-lockfile

FROM node:22-alpine AS runtime
# The runtime invokes Node directly. Remove unused package managers and their
# vulnerable transitive dependencies; application dependencies stay intact.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx
ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=production-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=production-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY content ./content

USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
