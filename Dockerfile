# syntax=docker/dockerfile:1.7
FROM node:22.22-alpine@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22.22-alpine@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd AS runtime
LABEL org.opencontainers.image.source="https://github.com/rhanka/pokemon-cards"
LABEL org.opencontainers.image.description="CardScope image recognition and account-backed collection API"
LABEL org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && mkdir -p /data \
    && chown -R node:node /app /data
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --from=build --chown=node:node /app/recognition-data ./recognition-data

USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "dist-server/server/index.js"]
