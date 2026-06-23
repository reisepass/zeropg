# Migration-capable zeropg-db sidecar. One Dockerfile serves all migration apps
# via build args: it clones the app's REAL migrations at the pinned ref.
#   --build-arg MIG_GIT=https://github.com/lukevella/rallly
#   --build-arg MIG_REF=main
#   --build-arg MIG_PATH=packages/database/prisma/migrations
# Extensions are chosen at runtime via ZEROPG_EXTENSIONS (e.g. "citext,pgcrypto").
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# @zeropg/* from the packed WORKSPACE tarballs (current code with extensions
# support); peers + the pg client installed explicitly.
COPY zeropg-blobstore-0.0.1.tgz zeropg-lease-0.0.1.tgz zeropg-objectstore-fs-0.0.1.tgz zeropg-server-0.0.1.tgz ./
RUN npm install --no-audit --no-fund \
      ./zeropg-blobstore-0.0.1.tgz \
      ./zeropg-lease-0.0.1.tgz \
      ./zeropg-objectstore-fs-0.0.1.tgz \
      ./zeropg-server-0.0.1.tgz \
      @electric-sql/pglite@^0.5 \
      @electric-sql/pglite-socket@^0.2 \
      pg@^8 \
 && npm cache clean --force

# Bake the app's real migrations.
ARG MIG_GIT
ARG MIG_REF=main
ARG MIG_PATH
RUN git clone --depth 1 --branch "$MIG_REF" "$MIG_GIT" /tmp/app \
 && cp -r "/tmp/app/$MIG_PATH" /app/migrations \
 && rm -rf /tmp/app \
 && echo "baked $(ls /app/migrations | wc -l) migrations from $MIG_GIT@$MIG_REF/$MIG_PATH"

COPY server.mjs ./

ENV NODE_ENV=production
CMD ["node", "server.mjs"]
