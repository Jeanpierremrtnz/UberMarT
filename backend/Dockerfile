# Construir desde la raíz del repositorio:
#   docker build -f backend/Dockerfile -t ubermart-api .
FROM node:22.22.0-bookworm-slim AS deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22.22.0-bookworm-slim
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-proto=delete
WORKDIR /app
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY backend/package.json ./backend/
COPY backend/src ./backend/src
COPY backend/migrations ./backend/migrations
COPY backend/scripts ./backend/scripts
COPY admin ./admin
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
WORKDIR /app/backend
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
