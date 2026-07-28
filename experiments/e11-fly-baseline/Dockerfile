# Slim image for the E11 Fly.io baseline: the bundled Node ESM standalone server
# (ZeroPG + pglite-socket wire + HTTP control face) and nothing else.
#
# Differs from experiments/standalone-service/Dockerfile in one way: PostgREST is
# NOT fetched. E11 measures raw-wire connect-to-first-row on a cold Machine, and
# the auto-REST surface is not part of that question. Dropping it removes ~2.5s
# of cold start and ~20-40MB RSS (results/standalone-ram.jsonl), which would
# otherwise contaminate the cold-start number this experiment exists to produce.
FROM node:22-slim

WORKDIR /app

# Runtime deps only (PGlite + pglite-socket). The bundle inlines all @zeropg/*.
COPY image-package.json package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY dist/server.mjs ./server.mjs
COPY dist/seed.tar.gz ./seed.tar.gz

ENV NODE_ENV=production
ENV PORT=8080
ENV ZEROPG_POSTGREST=off
EXPOSE 8080
EXPOSE 5432

CMD ["node", "server.mjs"]
