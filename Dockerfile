ARG NODE_IMAGE=docker.m.daocloud.io/library/node:20-alpine

FROM ${NODE_IMAGE} AS builder

WORKDIR /app

ARG BUILD_DATABASE_URL
ARG BUILD_DATABASE_SSL=disable
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_FETCH_RETRIES=5
ARG NPM_FETCH_RETRY_MINTIMEOUT=20000
ARG NPM_FETCH_RETRY_MAXTIMEOUT=120000

COPY . .
RUN npm config set registry "${NPM_REGISTRY}" \
  && npm config set fetch-retries "${NPM_FETCH_RETRIES}" \
  && npm config set fetch-retry-mintimeout "${NPM_FETCH_RETRY_MINTIMEOUT}" \
  && npm config set fetch-retry-maxtimeout "${NPM_FETCH_RETRY_MAXTIMEOUT}" \
  && npm config set fund false \
  && npm config set audit false
RUN set -eux; \
  i=1; \
  until [ "$i" -gt 3 ]; do \
    npm ci --no-audit --no-fund && break; \
    echo "npm ci failed ($i/3), retrying..."; \
    npm cache clean --force; \
    i=$((i + 1)); \
    sleep 5; \
  done; \
  [ "$i" -le 3 ]
RUN DATABASE_URL="${BUILD_DATABASE_URL}" DATABASE_SSL="${BUILD_DATABASE_SSL}" npm run build
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321

COPY --from=builder /app ./

EXPOSE 4321

CMD ["node", "dist/server/entry.mjs"]
