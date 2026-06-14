# Slim production image for the zeropg loadtest-service (single-writer lease
# stress test). The server is a pre-bundled single ESM file; only
# @electric-sql/pglite (with its WASM/data assets) is installed at build time.
FROM node:22-slim

WORKDIR /app

COPY image-package.json package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY dist/server.mjs ./server.mjs
COPY dist/seed.tar.gz ./seed.tar.gz

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.mjs"]
