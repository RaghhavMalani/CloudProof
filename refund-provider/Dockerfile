FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_FILE=/data/refunds.json

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && mkdir -p /data \
    && chown node:node /data

COPY --chown=node:node index.js ./

USER node
EXPOSE 6000
VOLUME ["/data"]

HEALTHCHECK --interval=5s --timeout=2s --start-period=2s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-6000}/health" >/dev/null || exit 1

CMD ["node", "index.js"]
