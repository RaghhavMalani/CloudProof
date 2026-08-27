FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data

# The upstream Node tag can briefly lag fixed Alpine security packages.
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
# Every runtime module, listed explicitly rather than `COPY . .` so test files
# and fixtures stay out of the image. The cost of that choice is that adding a
# module means editing this line — and forgetting to is exactly the bug that
# shipped here: log-store.js and state-machine.js were split out of raft.js and
# not added, which produces a container that builds cleanly and then dies on
# MODULE_NOT_FOUND the moment it starts.
COPY --chown=node:node package.json docker-entrypoint.sh ./
COPY --chown=node:node index.js raft.js log-store.js state-machine.js agent-state.js hnsw.js quantize.js sparse.js ./

RUN mkdir -p /data \
    && chown node:node /data \
    && chmod +x /app/docker-entrypoint.sh

USER node
EXPOSE 5000
VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-5000}/health" >/dev/null || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
