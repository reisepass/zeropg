# zeropg-sidecar: wraps the zeropg wire server as a Cloud Run sidecar.
# Exposes the real Postgres wire protocol on :5432 (0.0.0.0) so the app
# container in the same Cloud Run service can reach it at localhost:5432.
# Storage is env-driven (ZEROPG_BUCKET/prefix/durability).
# The HTTP control face on :8080 serves /ready for Cloud Run startup probes.
FROM node:22-slim

WORKDIR /app

# pg_isready ships with postgresql-client; we also need curl/ca-certs for GCS.
# Install once, keep only what the runtime needs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       postgresql-client \
       ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install only the runtime npm deps (PGlite + pglite-socket).
# The bundle inlines everything else (@zeropg/*).
COPY image-package.json package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Bundled server and the empty-datadir seed snapshot (skips initdb on fresh DB).
COPY dist/server.mjs ./server.mjs
COPY dist/seed.tar.gz ./seed.tar.gz

# A small healthcheck script that mirrors pg_isready: polls /ready on the HTTP
# control face until {"ready":true}. Cloud Run startup probes call this; the
# app container waits until it passes before starting.
COPY healthcheck.sh ./healthcheck.sh
RUN chmod +x ./healthcheck.sh

ENV NODE_ENV=production
# HTTP control face (Cloud Run routes inbound HTTP here, not to :5432).
ENV PORT=8080
# Wire protocol: 0.0.0.0 so the app container reaches it at localhost:5432.
ENV ZEROPG_WIRE_HOST=0.0.0.0
ENV ZEROPG_WIRE_PORT=5432
# PostgREST is off in the sidecar role; app connects via wire protocol directly.
ENV ZEROPG_POSTGREST=off
# Default durability: sleep (flush on idle/shutdown).
ENV ZEROPG_DURABILITY=sleep

# HTTP control face
EXPOSE 8080
# Postgres wire protocol (only reachable within the Cloud Run service over localhost)
EXPOSE 5432

HEALTHCHECK --interval=5s --timeout=10s --start-period=120s --retries=24 \
  CMD ["/app/healthcheck.sh"]

CMD ["node", "server.mjs"]
