# nostream's GCS-backed zeropg "database" sidecar for Cloud Run.
# = ZeroPGServer (ObjectStoreFS + lease + Postgres wire) + nostream's REAL knex
# migrations, baked at a pinned ref and applied over the wire on boot.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# @zeropg/* from the packed WORKSPACE tarballs (current code with extensions
# support); peers + the pg client + knex installed explicitly.
COPY zeropg-blobstore-0.0.1.tgz zeropg-lease-0.0.1.tgz zeropg-objectstore-fs-0.0.1.tgz zeropg-server-0.0.1.tgz ./
RUN npm install --no-audit --no-fund \
      ./zeropg-blobstore-0.0.1.tgz \
      ./zeropg-lease-0.0.1.tgz \
      ./zeropg-objectstore-fs-0.0.1.tgz \
      ./zeropg-server-0.0.1.tgz \
      @electric-sql/pglite@^0.5 \
      @electric-sql/pglite-socket@^0.2 \
 && npm cache clean --force

# Bake nostream's knexfile + migrations at a pinned ref, and install just the
# knex CLI + pg there so `knex migrate:latest` runs against the wire.
ARG NOSTREAM_GIT=https://github.com/cameri/nostream
ARG NOSTREAM_REF=main
RUN git clone --depth 1 --branch "$NOSTREAM_REF" "$NOSTREAM_GIT" /tmp/nostream \
 && mkdir -p /nostream \
 && cp /tmp/nostream/knexfile.js /nostream/ \
 && cp -r /tmp/nostream/migrations /nostream/migrations \
 && rm -rf /tmp/nostream \
 && echo "baked $(ls /nostream/migrations | wc -l) nostream migrations from $NOSTREAM_GIT@$NOSTREAM_REF"
RUN cd /nostream && npm install --no-audit --no-fund knex@^3 pg@^8 && npm cache clean --force

COPY server.mjs ./

ENV NODE_ENV=production
ENV NOSTREAM_DIR=/nostream
CMD ["node", "server.mjs"]
