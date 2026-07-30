FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json raft.js index.js docker-entrypoint.sh ./

RUN mkdir -p /data \
    && chown node:node /data \
    && chmod +x /app/docker-entrypoint.sh

USER node
EXPOSE 5000
VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-5000}/health" >/dev/null || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
