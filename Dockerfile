# The standalone server (server/bun.ts) with the built client, for Docker and Kubernetes. One replica: rooms live in
# memory. Cloudflare deploys don't use this (see `bun run deploy`).

# ---- build: the client bundle and the shared-code build id ----
FROM oven/bun:1.4.3-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ---- runtime: Bun runs the TypeScript server directly; it needs no packages ----
FROM oven/bun:1.4.3-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/dist \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
WORKDIR /app
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/dist/labs/blackout ./dist
USER bun
EXPOSE 8080
CMD ["bun", "server/bun.ts"]
