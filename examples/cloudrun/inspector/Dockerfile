# zeropg fleet inspector ingress: replica-wire manager + adminer proxy.
FROM node:22-slim
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund \
      @zeropg/blobstore@0.0.1 \
      @zeropg/objectstore-fs@0.0.1 \
      @zeropg/lease@0.0.1 \
      @electric-sql/pglite@^0.5 \
      @electric-sql/pglite-socket@^0.2 \
 && npm cache clean --force
# replica-wire.mjs is copied into this context by deploy.sh from
# packages/cli/src/console/replica-wire.mjs (the single source of truth).
COPY server.mjs replica-wire.mjs ./
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
