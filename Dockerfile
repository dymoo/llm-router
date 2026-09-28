# Gateway only. Do not bake Halogen into this image (upstream license forbids
# redistributing a modified combined image; cheap gateway rebuilds must not
# reload the generator).
# Requires next.config output: "standalone" and a committed package-lock.json.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p public \
  && npm run build \
  && test -f .next/standalone/server.js

FROM node:24-bookworm-slim AS runner
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_MANUAL_SIG_HANDLE=true
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV SQLITE_PATH=/var/lib/llm-router/control.sqlite
ENV MODEL_CATALOG=/etc/llm-router/catalog.json

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/llm-router /etc/llm-router /opt/ops \
  && chown -R node:node /var/lib/llm-router /etc/llm-router /opt/ops /app

COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/migrations ./migrations
COPY --chown=node:node scripts/backup.mjs scripts/restore.mjs scripts/sqlite-ops.mjs scripts/discover-local.mjs scripts/discover-halogen.mjs /opt/ops/

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "server.js"]
