FROM node:24-alpine AS dependencies
WORKDIR /app
COPY gateway/package.json gateway/package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node gateway/package.json gateway/index.js ./
COPY --chown=node:node frontend /frontend

USER node
EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4000}/health" >/dev/null || exit 1

CMD ["node", "index.js"]
