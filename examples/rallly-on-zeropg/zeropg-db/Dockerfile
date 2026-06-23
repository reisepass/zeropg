FROM node:22-slim

# git: to fetch Rallly's REAL, untouched migrations at build time.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# @zeropg/client is installed from a packed tarball (run ../prepare.sh first) so
# this example works without publishing. Its peers (PGlite + the wire) are
# installed explicitly; the contrib extensions ship inside @electric-sql/pglite.
COPY zeropg-client-0.0.1.tgz ./
RUN npm install --no-audit --no-fund \
      ./zeropg-client-0.0.1.tgz \
      @electric-sql/pglite@^0.5 \
      @electric-sql/pglite-socket@^0.2

# Rallly's real Prisma migrations, copied verbatim from their repo (not modified).
RUN git clone --depth 1 https://github.com/lukevella/rallly /tmp/rallly \
 && cp -r /tmp/rallly/packages/database/prisma/migrations /app/migrations \
 && rm -rf /tmp/rallly

COPY server.mjs ./

EXPOSE 5432
CMD ["node", "server.mjs"]
