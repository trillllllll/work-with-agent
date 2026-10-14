# Build the full workspace (server tsc + client vite) with every dependency,
# then ship a slim runtime with production modules plus the prisma CLI,
# which the server invokes on startup to apply migrations.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY server/prisma server/prisma
RUN npx prisma generate --schema server/prisma/schema.prisma
COPY server server
COPY client client
RUN npm run build -w server && npm run build -w client

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/prisma server/prisma
COPY --from=build /app/client/dist client-dist
COPY --from=build /app/node_modules node_modules
RUN npm prune --omit=dev \
  && npm install --no-save "prisma@$(node -p "require('./server/package.json').devDependencies.prisma")" \
  && npx prisma generate --schema server/prisma/schema.prisma

# Compose overrides these per deployment; the defaults describe a server-mode container.
ENV WWA_SERVER_MODE=1 \
    WWA_BIND_HOST=0.0.0.0 \
    PORT=3016 \
    WWA_DATA_DIR=/data \
    DATABASE_URL=file:/data/agent-studio.db \
    KNOWLEDGE_STORAGE_ROOT=/data/knowledge-blobs \
    WWA_RUNNER_DIR=/data/runner \
    AGENT_WORKSPACE_ROOT=/data/workspace \
    WWA_STATIC_DIR=/app/client-dist \
    WWA_SNAPSHOT_DIR=/data/snapshots

VOLUME /data
EXPOSE 3016
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3016) + '/api/v1/server/info').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/dist/index.js"]
