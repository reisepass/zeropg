FROM node:22-slim

# git: to fetch Documenso's REAL, untouched Prisma migrations at build time.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# @zeropg/client is installed from a packed tarball (copied into the build
# context) so this example works without publishing. Its peers (PGlite + the
# wire) are installed explicitly; the contrib extensions ship inside
# @electric-sql/pglite.
COPY zeropg-client-0.0.1.tgz ./
RUN npm install --no-audit --no-fund \
      ./zeropg-client-0.0.1.tgz \
      @electric-sql/pglite@^0.5 \
      @electric-sql/pglite-socket@^0.2

# Documenso's real Prisma migrations, copied verbatim from their repo at the
# v2.13.0 tag (not modified). These are the exact SQL files Documenso's own
# `prisma migrate deploy` would apply.
RUN git clone --depth 1 --branch v2.13.0 https://github.com/documenso/documenso /tmp/documenso \
 && cp -r /tmp/documenso/packages/prisma/migrations /app/migrations \
 && rm -rf /tmp/documenso

COPY server.mjs ./

EXPOSE 5432
CMD ["node", "server.mjs"]
