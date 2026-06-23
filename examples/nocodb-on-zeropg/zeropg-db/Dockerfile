FROM node:22-slim

WORKDIR /app

# @zeropg/client is installed from a packed tarball (copied from the shared pack
# dir) so this example builds without publishing. Its peers (PGlite + the wire)
# are installed explicitly.
COPY zeropg-client-0.0.1.tgz ./
RUN npm install --no-audit --no-fund \
      ./zeropg-client-0.0.1.tgz \
      @electric-sql/pglite@^0.5 \
      @electric-sql/pglite-socket@^0.2

COPY server.mjs ./

EXPOSE 5432
CMD ["node", "server.mjs"]
