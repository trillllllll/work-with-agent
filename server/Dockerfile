# Build the full workspace (server tsc + client vite) with every dependency,
# then ship a slim runtime with production modules plus the prisma CLI,
# which the server invokes on startup to apply migrations.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci && mkdir -p server/node_modules
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
COPY --from=build /app/server/node_modules server/node_modules
RUN npm prune --omit=dev \
  && npm install --no-save "prisma@$(node -p "require('./server/package.json').devDependencies.prisma")" \
  && npx prisma generate --schema server/prisma/schema.prisma

# Container fallbacks are applied only after explicit DOVUN_* / WWA_* settings.
# Injecting new-name defaults here would mask an existing legacy override.
ENV DOVUN_CONTAINER=1 \
    PORT=3016 \
    KNOWLEDGE_STORAGE_ROOT=/data/knowledge-blobs \
    AGENT_WORKSPACE_ROOT=/data/workspace

VOLUME /data
EXPOSE 3016
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3016) + '/api/v1/server/info').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/dist/index.js"]
