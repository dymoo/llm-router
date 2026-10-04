# Gateway only: the model runtime (Gufo) runs on the GPU host.
# `runner` (default for Compose) is the API server plus the static console it serves itself.
# `fly` adds WireGuard, Caddy and Litestream for the Fly.io machine (deploy/fly/).

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node

FROM node AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && test -f out/index.html && test -f dist/server/main.mjs

FROM node AS runner
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV CONSOLE_DIR=/app/out
ENV SQLITE_PATH=/var/lib/llm-router/control.sqlite
ENV MODEL_CATALOG=/etc/llm-router/catalog.json

RUN mkdir -p /var/lib/llm-router /etc/llm-router /opt/ops \
  && chown -R node:node /var/lib/llm-router /etc/llm-router /opt/ops /app

# The server is one esbuild bundle: no node_modules at runtime. It finds migrations at
# dist/server/../../migrations, so keep that layout.
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/out ./out
COPY --from=builder --chown=node:node /app/migrations ./migrations
COPY --chown=node:node scripts/backup.mjs scripts/restore.mjs scripts/sqlite-ops.mjs /opt/ops/

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "dist/server/main.mjs"]

FROM node AS fly-tools
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp
RUN curl -fsSLo caddy.tgz https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_amd64.tar.gz \
  && echo "a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7  caddy.tgz" | sha512sum -c - \
  && tar -xzf caddy.tgz caddy \
  && curl -fsSLo litestream.tgz https://github.com/benbjohnson/litestream/releases/download/v0.5.17/litestream-0.5.17-linux-x86_64.tar.gz \
  && echo "cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d  litestream.tgz" | sha256sum -c - \
  && tar -xzf litestream.tgz litestream

FROM runner AS fly
USER root
# Kernel WireGuard via wg-quick; curl is for operators (fly ssh console) only.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl iproute2 wireguard-tools \
  && rm -rf /var/lib/apt/lists/*
COPY --from=fly-tools /tmp/caddy /tmp/litestream /usr/local/bin/
COPY deploy/fly/Caddyfile /etc/caddy/Caddyfile
COPY deploy/fly/litestream.yml /etc/litestream.yml
COPY deploy/fly/entrypoint.sh /usr/local/bin/entrypoint
# The supervisor runs as root for wg-quick; the API server drops to `node` (entrypoint).
CMD ["/usr/local/bin/entrypoint"]
