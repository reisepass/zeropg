# The GCS-backed zeropg "database" sidecar for the stripped Supabase stack.
#
# = ZeroPGServer (ObjectStoreFS + single-writer lease + Postgres wire) from npm
#   + pgvector preloaded (@electric-sql/pglite-pgvector, the separate package, NOT
#     contrib/*) + pgcrypto contrib
#   + the PostgREST Haskell static binary, which @zeropg/server spawns in-process
#     against the local wire with the single-session kill-switch
#     (PGRST_DB_PREPARED_STATEMENTS=false, PGRST_DB_POOL=1).
#
# Collapsing PostgREST into this sidecar means the Supabase REST surface needs no
# extra container; only GoTrue runs as its own app container.
FROM node:22-slim

# PostgREST static binary. The linux-static asset is a fully static Haskell
# executable (no glibc/gmp runtime deps), so it runs as-is on node:22-slim.
ARG POSTGREST_VERSION=v14.13
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && curl -fsSL -o /tmp/postgrest.tar.xz \
      "https://github.com/PostgREST/postgrest/releases/download/${POSTGREST_VERSION}/postgrest-${POSTGREST_VERSION}-linux-static-x86-64.tar.xz" \
 && tar -xJf /tmp/postgrest.tar.xz -C /usr/local/bin \
 && chmod +x /usr/local/bin/postgrest \
 && apt-get purge -y xz-utils \
 && apt-get autoremove -y \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /tmp/postgrest.tar.xz \
 && /usr/local/bin/postgrest --help >/dev/null

WORKDIR /app

# Install @zeropg/* from LOCAL-built tarballs (vendor/), NOT npm. The published
# @zeropg/objectstore-fs@0.0.1 calls PGlite.create({ dataDir }) WITHOUT forwarding
# `extensions`, so CREATE EXTENSION vector fails ("extension not available") on a
# ZeroPGServer datadir. The local build forwards extensions (verified). package.json
# uses file: deps + overrides so the inter-package ^0.0.1 refs resolve to the tarballs.
COPY package.json ./
COPY vendor ./vendor
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY server.mjs bootstrap.sql ./

ENV NODE_ENV=production
ENV ZEROPG_POSTGREST_BIN=/usr/local/bin/postgrest
# PORT is the HTTP control/health face (set in the service spec for a sidecar).
CMD ["node", "server.mjs"]
