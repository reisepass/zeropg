# Nightly demo-reset job image. The job is a pre-bundled single ESM file; only
# @electric-sql/pglite (with its WASM/data assets) is installed at build time.
FROM node:22-slim

WORKDIR /app

COPY image-package.json package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY dist/reset.mjs ./reset.mjs

ENV NODE_ENV=production

CMD ["node", "reset.mjs"]
