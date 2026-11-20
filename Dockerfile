# Complements: one container serves the game server, the player page and the instructor console.
# Run exactly ONE instance: live game state is held in memory.

FROM node:22.12-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev
COPY engine engine
COPY web web
COPY server server
RUN cd web && npm run build

FROM node:22.12-alpine
WORKDIR /app
ENV NODE_ENV=production \
    STATIC_DIR=/app/web/dist \
    PORT=8080
COPY --from=build /app/engine engine
COPY --from=build /app/server/src server/src
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/web/dist web/dist
# The event log lives on a mounted disk (DATA_FILE) or in Postgres (DATABASE_URL).
RUN mkdir -p /var/data && chown node:node /var/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "--experimental-strip-types", "--no-warnings", "server/src/main.ts"]
