# The GCS-backed zeropg "database" sidecar image for Cloud Run.
# Installs @zeropg/server (ObjectStoreFS + lease + Postgres wire) from npm; the
# PGlite WASM + the socket wire come from the peer deps. No app, no extensions
# (PrivateBin's schema needs none).
FROM node:22-slim

WORKDIR /app

RUN npm install --omit=dev --no-audit --no-fund \
      @zeropg/server@0.0.1 \
      @zeropg/blobstore@0.0.1 \
      @electric-sql/pglite@^0.5 \
      @electric-sql/pglite-socket@^0.2 \
 && npm cache clean --force

COPY server.mjs ./

ENV NODE_ENV=production
ENV ZEROPG_POSTGREST=off
# PORT is the HTTP control/health face (Cloud Run injects PORT for the ingress
# container; for a sidecar we set it explicitly in the service spec).
CMD ["node", "server.mjs"]
