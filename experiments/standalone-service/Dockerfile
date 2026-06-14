# Slim production image for the zeropg STANDALONE server: the bundled Node ESM
# server (ZeroPG + pglite-socket wire + HTTP control face) plus the PostgREST
# static binary it spawns for the auto-REST surface.
FROM node:22-slim

WORKDIR /app

# PostgREST is a single fully-static (musl) Haskell binary — no runtime libs
# needed on the slim image. Fetch + extract it at build time, then drop the
# build-only tools.
ARG PGRST_VERSION=v14.13
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl xz-utils ca-certificates \
  && curl -fsSL -o /tmp/postgrest.tar.xz \
       "https://github.com/PostgREST/postgrest/releases/download/${PGRST_VERSION}/postgrest-${PGRST_VERSION}-linux-static-x86-64.tar.xz" \
  && tar -xJf /tmp/postgrest.tar.xz -C /usr/local/bin postgrest \
  && rm /tmp/postgrest.tar.xz \
  && /usr/local/bin/postgrest --version \
  && apt-get purge -y curl xz-utils && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# Install only the runtime deps (PGlite + pglite-socket). The bundle inlines
# everything else (@zeropg/*).
COPY image-package.json package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# The bundled server and the empty-datadir seed snapshot.
COPY dist/server.mjs ./server.mjs
COPY dist/seed.tar.gz ./seed.tar.gz

ENV NODE_ENV=production
ENV PORT=8080
# PostgREST is the auto-REST surface; default-on. Set ZEROPG_POSTGREST=off to
# skip it (saves the ~20MB RSS the standalone-ram experiment measures).
ENV ZEROPG_POSTGREST=on
ENV ZEROPG_POSTGREST_BIN=/usr/local/bin/postgrest
EXPOSE 8080

CMD ["node", "server.mjs"]
