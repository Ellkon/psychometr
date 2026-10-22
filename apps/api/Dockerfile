# API image: multi-stage, non-root runtime. Build context is the repo root.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/api apps/api
COPY content content
RUN pnpm --filter @psychometr/shared build && pnpm --filter @psychometr/api build

FROM node:22-alpine AS runtime
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app ./
RUN pnpm prune --prod

USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
